import {
  computeCharge, issueTicketToken, scanOutcome, tokenForTicketId, verifyTicketToken,
  type ChargeKind, type PlayerTournamentState, type TournamentConfig,
} from "@tivbook/core";
import { STAFF, type Handler } from "../context.js";
import { ApiError, audit, fail, ms, requireRole, str } from "../util.js";

const KINDS: ChargeKind[] = ["buy_in", "reentry", "rebuy", "addon"];
const LEDGER_TYPE = { buy_in: "tournament_buy_in", reentry: "reentry", rebuy: "rebuy", addon: "addon", bonus: "bonus" } as const;
const COUNTER = { reentry: "reentries", rebuy: "rebuys", addon: "addons" } as const;

/** Tournament config is stored as JSON with ISO dates; convert to the core engine's shape. */
export function toConfig(id: string, cfg: Record<string, any>): TournamentConfig {
  return {
    id, formats: cfg.formats ?? [], buyInCents: cfg.buyInCents, startingChips: cfg.startingChips,
    startAt: ms(cfg.startAt), lateRegCloseAt: ms(cfg.lateRegCloseAt), maxEntries: cfg.maxEntries ?? null,
    reentry: cfg.reentry ?? null,
    rebuy: cfg.rebuy ? { ...cfg.rebuy, closesAt: ms(cfg.rebuy.closesAt) } : null,
    addon: cfg.addon ? { ...cfg.addon, opensAt: ms(cfg.addon.opensAt), closesAt: ms(cfg.addon.closesAt) } : null,
    bonus: cfg.bonus ?? null,
  };
}

interface TicketOut { ticketId: string; token: string; kind: string; chips: number; priceCents: number }
interface PaymentResult { entryId: string; totalCents: number; totalChips: number; tickets: TicketOut[] }

/**
 * Cashier records a tournament payment. In ONE transaction: eligibility, ledger lines,
 * entry, entitlements, tickets and counters. A repeated idempotencyKey returns the
 * original result and charges nothing.
 */
export const recordTournamentPayment: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.cashier);
  const tournamentId = str(d.tournamentId, "tournamentId", 60);
  const playerId = str(d.playerId, "playerId", 12);
  const kind = d.kind as ChargeKind;
  if (!KINDS.includes(kind)) fail("INVALID_ARGUMENT", "Unknown payment kind.");
  const method = d.method === "card" ? "card" : "cash";
  const key = str(d.idempotencyKey, "idempotencyKey", 80);
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) fail("INVALID_ARGUMENT", "Invalid idempotency key.");
  const secret = ctx.env.TICKET_SECRET;

  return ctx.sql.begin(async (tx): Promise<PaymentResult> => {
    await tx`select pg_advisory_xact_lock(hashtext(${key}))`;
    const [done] = await tx`select result from idempotency where key = ${key}`;
    if (done) {
      const r = done.result as PaymentResult;
      return { ...r, tickets: r.tickets.map((t) => ({ ...t, token: tokenForTicketId(t.ticketId, secret) })) };
    }
    const [t] = await tx`select * from tournaments where id = ${tournamentId} for update`;
    if (!t) throw new ApiError("NOT_FOUND", "Tournament not found.", 404);
    const [p] = await tx`select kyc_status from players where player_id = ${playerId}`;
    if (!p) throw new ApiError("NOT_FOUND", "Player not found.", 404);
    if (p.kyc_status !== "verified") fail("ID_NOT_VERIFIED", "Verify the player's identity before taking payment.");
    const [shift] = await tx`select id from cashier_shifts where cashier_id = ${c.uid} and status = 'open'`;
    if (!shift) fail("NO_SHIFT", "Open your cashier shift first.");
    const [st] = await tx`select * from tournament_players where tournament_id = ${tournamentId} and player_id = ${playerId} for update`;
    const state: PlayerTournamentState = {
      paidEntries: st?.paid_entries ?? 0, rebuys: st?.rebuys ?? 0, addons: st?.addons ?? 0,
      hasActiveEntry: st?.has_active_entry ?? false, hasUndeliveredEntry: st?.has_undelivered_entry ?? false,
    };
    const charge = computeCharge(toConfig(tournamentId, t.config), kind, state, { withBonus: d.withBonus === true, nowMs: ctx.now(), totalEntriesSoFar: t.total_entries });
    if (!charge.ok) fail(charge.code, charge.message);
    const ok = charge as Extract<typeof charge, { ok: true }>;

    let preregId: string | null = null;
    if (typeof d.preregistrationId === "string") {
      const [pr] = await tx`select * from tournament_preregistrations where id = ${d.preregistrationId} for update`;
      if (!pr || pr.player_id !== playerId || pr.tournament_id !== tournamentId) fail("PREREG_MISMATCH", "Preregistration does not match.");
      if (pr!.status !== "preregistered") fail("PREREG_USED", "Preregistration already converted or cancelled.");
      preregId = pr!.id;
    }

    const isEntry = kind === "buy_in" || kind === "reentry";
    let entryId: string;
    if (isEntry) {
      const [e] = await tx`insert into tournament_entries (tournament_id, player_id, entry_number, status, preregistration_id, paid_at, cashier_id)
        values (${tournamentId}, ${playerId}, ${state.paidEntries + 1}, 'awaiting_chips', ${preregId}, now(), ${c.uid}) returning id`;
      entryId = e!.id;
    } else {
      if (!st?.current_entry_id) fail("NOT_IN_PLAY", "No current entry.");
      entryId = st!.current_entry_id;
    }

    const tickets: TicketOut[] = [];
    for (const [i, line] of ok.lines.entries()) {
      const tk = issueTicketToken(secret);
      const [l] = await tx`insert into ledger (player_id, type, amount_cents, direction, method, ref, cashier_id, station_id, shift_id, idempotency_key)
        values (${playerId}, ${LEDGER_TYPE[line.kind]}, ${line.priceCents}, 'in', ${method}, ${tx.json({ tournamentId, entryId })},
                ${c.uid}, ${c.deviceId ?? null}, ${shift!.id}, ${`${key}:${i}`}) returning id`;
      const [ent] = await tx`insert into entitlements (entry_id, tournament_id, player_id, kind, price_cents, chips, payment_txn_id, ticket_id)
        values (${entryId}, ${tournamentId}, ${playerId}, ${line.kind}, ${line.priceCents}, ${line.chips}, ${l!.id}, ${tk.ticketId}) returning id`;
      await tx`insert into tickets (id, entitlement_id, entry_id, tournament_id, player_id, kind, chips, token_hash, paid)
        values (${tk.ticketId}, ${ent!.id}, ${entryId}, ${tournamentId}, ${playerId}, ${line.kind}, ${line.chips}, ${tk.tokenHash}, true)`;
      tickets.push({ ticketId: tk.ticketId, token: tk.token, kind: line.kind, chips: line.chips, priceCents: line.priceCents });
    }

    const hasBonus = ok.lines.some((l) => l.kind === "bonus");
    await tx`update tournaments set
        revenue_cents = revenue_cents + ${ok.totalCents},
        pending_chip_deliveries = pending_chip_deliveries + ${ok.lines.length},
        paid = paid + ${kind === "buy_in" ? 1 : 0}, unique_players = unique_players + ${kind === "buy_in" ? 1 : 0},
        total_entries = total_entries + ${isEntry ? 1 : 0},
        reentries = reentries + ${kind === "reentry" ? 1 : 0}, rebuys = rebuys + ${kind === "rebuy" ? 1 : 0}, addons = addons + ${kind === "addon" ? 1 : 0},
        bonuses = bonuses + ${hasBonus ? 1 : 0}, preregistered = preregistered - ${preregId ? 1 : 0}
      where id = ${tournamentId}`;
    void COUNTER;
    await tx`insert into tournament_players (tournament_id, player_id, paid_entries, rebuys, addons, has_active_entry, has_undelivered_entry, current_entry_id)
      values (${tournamentId}, ${playerId}, ${isEntry ? 1 : 0}, ${kind === "rebuy" ? 1 : 0}, ${kind === "addon" ? 1 : 0}, false, ${isEntry}, ${entryId})
      on conflict (tournament_id, player_id) do update set
        paid_entries = tournament_players.paid_entries + ${isEntry ? 1 : 0},
        rebuys = tournament_players.rebuys + ${kind === "rebuy" ? 1 : 0},
        addons = tournament_players.addons + ${kind === "addon" ? 1 : 0},
        has_undelivered_entry = tournament_players.has_undelivered_entry or ${isEntry},
        current_entry_id = ${entryId}`;
    if (preregId) await tx`update tournament_preregistrations set status = 'converted', entry_id = ${entryId} where id = ${preregId}`;

    const result: PaymentResult = { entryId, totalCents: ok.totalCents, totalChips: ok.totalChips, tickets };
    // Printable codes are never stored; a retry re-derives them from ticketId + secret.
    await tx`insert into idempotency (key, result, by_user) values (${key}, ${tx.json({ ...result, tickets: tickets.map((x) => ({ ...x, token: "" })) } as never)}, ${c.uid})`;
    await audit(tx, { actor: c.uid, action: `tournament.payment.${kind}`, entity: `tournament_entries/${entryId}`, after: { totalCents: ok.totalCents }, deviceId: c.deviceId });
    return result;
  });
};

/** Floor scan, read-only: shows player, tournament and chips before handing anything over. */
export const validateTicket: Handler = async (ctx, d) => {
  await requireRole(ctx, STAFF.floor);
  const check = verifyTicketToken(str(d.code, "code", 100), ctx.env.TICKET_SECRET);
  if (!check.ok) return scanOutcome({ check, ticket: null, delivery: null });
  const [t] = await ctx.sql`select t.*, p.surname, p.first_names, tr.name as tournament_name from tickets t
    join players p on p.player_id = t.player_id join tournaments tr on tr.id = t.tournament_id where t.id = ${check.ticketId}`;
  if (!t || t.token_hash !== check.tokenHash) return scanOutcome({ check, ticket: null, delivery: null });
  const [dl] = await ctx.sql`select scanned_at, scanned_by from chip_deliveries where entitlement_id = ${t.entitlement_id}`;
  const outcome = scanOutcome({ check, ticket: { status: t.status, paid: t.paid, chips: t.chips }, delivery: dl ? { at: ms(dl.scanned_at), by: dl.scanned_by } : null });
  return { ...outcome, ticketId: t.id, kind: t.kind, player: { id: t.player_id, name: `${t.surname} ${t.first_names}` }, tournament: { id: t.tournament_id, name: t.tournament_name } };
};

/**
 * Floor confirms chips were handed over. chip_deliveries has the entitlement as primary key,
 * so a second scan (on any device, at the same instant) can never deliver chips twice.
 */
export const confirmChipDelivery: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.floor);
  const check = verifyTicketToken(str(d.code, "code", 100), ctx.env.TICKET_SECRET);
  if (!check.ok) fail("INVALID", "INVALID OR UNPAID TICKET");
  return ctx.sql.begin(async (tx) => {
    const [t] = await tx`select * from tickets where id = ${check.ticketId} for update`;
    if (!t || t.token_hash !== check.tokenHash) fail("INVALID", "INVALID OR UNPAID TICKET");
    const [dl] = await tx`select scanned_at, scanned_by from chip_deliveries where entitlement_id = ${t!.entitlement_id}`;
    const outcome = scanOutcome({ check, ticket: { status: t!.status, paid: t!.paid, chips: t!.chips }, delivery: dl ? { at: ms(dl.scanned_at), by: dl.scanned_by } : null });
    if (outcome.screen !== "VALID") return outcome;
    await tx`insert into chip_deliveries (entitlement_id, ticket_id, chips, scanned_by, device_id) values (${t!.entitlement_id}, ${t!.id}, ${outcome.chips}, ${c.uid}, ${c.deviceId ?? null})`;
    await tx`update tickets set status = 'used' where id = ${t!.id}`;
    const isEntry = t!.kind === "buy_in" || t!.kind === "reentry";
    if (isEntry) {
      await tx`update tournament_entries set status = 'entered', entered_at = now() where id = ${t!.entry_id}`;
      await tx`update tournament_players set has_active_entry = true, has_undelivered_entry = false where tournament_id = ${t!.tournament_id} and player_id = ${t!.player_id}`;
    }
    await tx`update tournaments set pending_chip_deliveries = pending_chip_deliveries - 1, chip_deliveries = chip_deliveries + 1,
      entered = entered + ${isEntry ? 1 : 0} where id = ${t!.tournament_id}`;
    await audit(tx, { actor: c.uid, action: "chips.deliver", entity: `chip_deliveries/${t!.entitlement_id}`, deviceId: c.deviceId });
    return outcome;
  });
};
