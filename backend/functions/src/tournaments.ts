import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import {
  computeCharge, issueTicketToken, scanOutcome, tokenForTicketId, verifyTicketToken,
  type ChargeKind, type PlayerTournamentState, type TournamentConfig,
} from "@tivbook/core";
import { audit, db, fail, idemGet, idemSet, REGION, requireRole, STAFF, str } from "./lib.js";

export const TICKET_SECRET = defineSecret("TICKET_SECRET");

const KINDS: ChargeKind[] = ["buy_in", "reentry", "rebuy", "addon"];
const LEDGER_TYPE = { buy_in: "tournament_buy_in", reentry: "reentry", rebuy: "rebuy", addon: "addon", bonus: "bonus" } as const;
const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : Number(v));

function toConfig(id: string, t: FirebaseFirestore.DocumentData): TournamentConfig {
  return {
    id,
    formats: t.formats ?? [],
    buyInCents: t.buyInCents,
    startingChips: t.startingChips,
    startAt: ms(t.startAt),
    lateRegCloseAt: ms(t.lateRegCloseAt),
    maxEntries: t.maxEntries ?? null,
    reentry: t.reentry ?? null,
    rebuy: t.rebuy ? { ...t.rebuy, closesAt: ms(t.rebuy.closesAt) } : null,
    addon: t.addon ? { ...t.addon, opensAt: ms(t.addon.opensAt), closesAt: ms(t.addon.closesAt) } : null,
    bonus: t.bonus ?? null,
  };
}

interface PaymentResult {
  entryId: string;
  totalCents: number;
  totalChips: number;
  tickets: Array<{ ticketId: string; token: string; kind: string; chips: number; priceCents: number }>;
}

/**
 * Cashier records a tournament payment. In ONE transaction: validates eligibility,
 * writes ledger lines, entry, entitlements, tickets and counters. A repeated
 * idempotencyKey (double click / retry) returns the original result and charges nothing.
 */
export const recordTournamentPayment = onCall({ region: REGION, secrets: [TICKET_SECRET] }, async (req): Promise<PaymentResult> => {
  const c = await requireRole(req, STAFF.cashier);
  const d = (req.data ?? {}) as Record<string, unknown>;
  const tournamentId = str(d.tournamentId, "tournamentId");
  const playerId = str(d.playerId, "playerId");
  const kind = d.kind as ChargeKind;
  if (!KINDS.includes(kind)) throw new HttpsError("invalid-argument", "Unknown payment kind.");
  const method = d.method === "card" ? "card" : "cash";
  const idempotencyKey = str(d.idempotencyKey, "idempotencyKey", 80);
  const secret = TICKET_SECRET.value();

  return db.runTransaction(async (tx) => {
    const idem = await idemGet<PaymentResult>(tx, idempotencyKey);
    if (idem.result) {
      // Same request retried: return the original result, re-deriving the printable codes.
      return { ...idem.result, tickets: idem.result.tickets.map((t) => ({ ...t, token: tokenForTicketId(t.ticketId, secret) })) };
    }

    const tRef = db.collection("tournaments").doc(tournamentId);
    const pRef = db.collection("players").doc(playerId);
    const stateRef = db.collection("tournament_players").doc(`${tournamentId}_${playerId}`);
    const [tSnap, pSnap, stSnap, shiftQ] = await Promise.all([
      tx.get(tRef), tx.get(pRef), tx.get(stateRef),
      tx.get(db.collection("cashier_shifts").where("cashierId", "==", c.uid).where("status", "==", "open").limit(1)),
    ]);
    if (!tSnap.exists) fail("NOT_FOUND", "Tournament not found.");
    if (!pSnap.exists) fail("NOT_FOUND", "Player not found.");
    if (pSnap.get("kycStatus") !== "verified") fail("ID_NOT_VERIFIED", "Verify the player's identity before taking payment.");
    if (shiftQ.empty) fail("NO_SHIFT", "Open your cashier shift first.");
    const shiftId = shiftQ.docs[0]!.id;

    const t = toConfig(tournamentId, tSnap.data()!);
    const state: PlayerTournamentState = {
      paidEntries: stSnap.get("paidEntries") ?? 0,
      rebuys: stSnap.get("rebuys") ?? 0,
      addons: stSnap.get("addons") ?? 0,
      hasActiveEntry: stSnap.get("hasActiveEntry") ?? false,
      hasUndeliveredEntry: stSnap.get("hasUndeliveredEntry") ?? false,
    };
    const charge = computeCharge(t, kind, state, {
      withBonus: d.withBonus === true, nowMs: Date.now(), totalEntriesSoFar: tSnap.get("counters.totalEntries") ?? 0,
    });
    if (!charge.ok) fail(charge.code, charge.message);

    // Prereg conversion (optional)
    let preregRef: DocumentReference | null = null;
    if (typeof d.preregistrationId === "string") {
      preregRef = db.collection("tournament_preregistrations").doc(d.preregistrationId);
      const pr = await tx.get(preregRef);
      if (!pr.exists || pr.get("playerId") !== playerId || pr.get("tournamentId") !== tournamentId) fail("PREREG_MISMATCH", "Preregistration does not match.");
      if (pr.get("status") !== "preregistered") fail("PREREG_USED", "Preregistration already converted or cancelled.");
    }

    // ── writes ──
    const isEntry = kind === "buy_in" || kind === "reentry";
    if (!isEntry && !stSnap.get("currentEntryId")) fail("NOT_IN_PLAY", "No current entry.");
    const entryRef = isEntry ? db.collection("tournament_entries").doc() : db.collection("tournament_entries").doc(stSnap.get("currentEntryId"));
    if (isEntry) {
      tx.create(entryRef, {
        tournamentId, playerId, entryNumber: state.paidEntries + 1, status: "awaiting_chips",
        preregistrationId: preregRef?.id ?? null, paidAt: FieldValue.serverTimestamp(), cashierId: c.uid,
      });
    }
    const tickets: PaymentResult["tickets"] = [];
    for (const line of charge.lines) {
      const ledgerRef = db.collection("ledger").doc();
      const entRef = db.collection("entitlements").doc();
      const tk = issueTicketToken(secret);
      tx.create(ledgerRef, {
        playerId, type: LEDGER_TYPE[line.kind], amountCents: line.priceCents, direction: "in", currency: "MUR", method,
        ref: { tournamentId, entryId: entryRef.id, entitlementId: entRef.id }, cashierId: c.uid, stationId: c.deviceId ?? null,
        shiftId, status: "completed", idempotencyKey: `${idempotencyKey}:${line.kind}`, createdAt: FieldValue.serverTimestamp(),
      });
      tx.create(entRef, { entryId: entryRef.id, tournamentId, playerId, kind: line.kind, priceCents: line.priceCents, chips: line.chips, paymentTxnId: ledgerRef.id, ticketId: tk.ticketId });
      tx.create(db.collection("tickets").doc(tk.ticketId), {
        entitlementId: entRef.id, entryId: entryRef.id, tournamentId, playerId, kind: line.kind, chips: line.chips,
        tokenHash: tk.tokenHash, status: "valid", paid: true, printedCount: 0, createdAt: FieldValue.serverTimestamp(),
      });
      tickets.push({ ticketId: tk.ticketId, token: tk.token, kind: line.kind, chips: line.chips, priceCents: line.priceCents });
    }
    const counters: Record<string, FieldValue> = {
      "counters.revenueCents": FieldValue.increment(charge.totalCents),
      "counters.pendingChipDeliveries": FieldValue.increment(charge.lines.length),
    };
    if (kind === "buy_in") { counters["counters.paid"] = FieldValue.increment(1); counters["counters.uniquePlayers"] = FieldValue.increment(1); }
    if (isEntry) counters["counters.totalEntries"] = FieldValue.increment(1);
    if (kind !== "buy_in") counters[`counters.${kind}s`] = FieldValue.increment(1);
    if (charge.lines.some((l) => l.kind === "bonus")) counters["counters.bonuses"] = FieldValue.increment(1);
    if (preregRef) { tx.update(preregRef, { status: "converted", entryId: entryRef.id }); counters["counters.preregistered"] = FieldValue.increment(-1); }
    tx.update(tRef, counters);
    tx.set(stateRef, {
      tournamentId, playerId,
      paidEntries: state.paidEntries + (isEntry ? 1 : 0),
      rebuys: state.rebuys + (kind === "rebuy" ? 1 : 0),
      addons: state.addons + (kind === "addon" ? 1 : 0),
      hasUndeliveredEntry: isEntry ? true : state.hasUndeliveredEntry,
      currentEntryId: entryRef.id,
    }, { merge: true });

    const result: PaymentResult = { entryId: entryRef.id, totalCents: charge.totalCents, totalChips: charge.totalChips, tickets };
    // Printable codes are not stored; a retry re-derives them from ticketId + secret.
    idemSet(tx, idem.ref, c.uid, { ...result, tickets: tickets.map((t) => ({ ...t, token: "" })) });
    audit(tx, { actor: c.uid, action: `tournament.payment.${kind}`, entity: entryRef.path, after: { totalCents: charge.totalCents }, deviceId: c.deviceId });
    return result;
  });
});

/** Floor scan, read-only: shows who/what before chips are handed over. */
export const validateTicket = onCall({ region: REGION, secrets: [TICKET_SECRET] }, async (req) => {
  await requireRole(req, STAFF.floor);
  const check = verifyTicketToken(str((req.data as { code?: string })?.code, "code", 100), TICKET_SECRET.value());
  if (!check.ok) return scanOutcome({ check, ticket: null, delivery: null });
  const tSnap = await db.collection("tickets").doc(check.ticketId).get();
  if (!tSnap.exists || tSnap.get("tokenHash") !== check.tokenHash) return scanOutcome({ check, ticket: null, delivery: null });
  const dSnap = await db.collection("chip_deliveries").doc(tSnap.get("entitlementId")).get();
  const outcome = scanOutcome({
    check,
    ticket: { status: tSnap.get("status"), paid: tSnap.get("paid") === true, chips: tSnap.get("chips") },
    delivery: dSnap.exists ? { at: ms(dSnap.get("scannedAt")), by: dSnap.get("scannedByName") ?? dSnap.get("scannedBy") } : null,
  });
  const player = await db.collection("players").doc(tSnap.get("playerId")).get();
  const tournament = await db.collection("tournaments").doc(tSnap.get("tournamentId")).get();
  return {
    ...outcome,
    ticketId: check.ticketId,
    kind: tSnap.get("kind"),
    player: { id: player.id, name: `${player.get("surname")} ${player.get("firstNames")}` },
    tournament: { id: tournament.id, name: tournament.get("name") },
  };
});

/**
 * Floor confirms chips were handed over. `chip_deliveries/{entitlementId}` is created
 * with tx.create — if another scanner already did it, this transaction fails, so
 * chips can never be delivered twice for the same ticket.
 */
export const confirmChipDelivery = onCall({ region: REGION, secrets: [TICKET_SECRET] }, async (req) => {
  const c = await requireRole(req, STAFF.floor);
  const check = verifyTicketToken(str((req.data as { code?: string })?.code, "code", 100), TICKET_SECRET.value());
  if (!check.ok) fail("INVALID", "INVALID OR UNPAID TICKET");
  return db.runTransaction(async (tx) => {
    const tRef = db.collection("tickets").doc(check.ticketId);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists || tSnap.get("tokenHash") !== check.tokenHash) fail("INVALID", "INVALID OR UNPAID TICKET");
    const entitlementId = tSnap.get("entitlementId") as string;
    const dRef = db.collection("chip_deliveries").doc(entitlementId);
    const dSnap = await tx.get(dRef);
    const outcome = scanOutcome({
      check,
      ticket: { status: tSnap.get("status"), paid: tSnap.get("paid") === true, chips: tSnap.get("chips") },
      delivery: dSnap.exists ? { at: ms(dSnap.get("scannedAt")), by: dSnap.get("scannedBy") } : null,
    });
    if (outcome.screen !== "VALID") return outcome;
    const kind = tSnap.get("kind") as string;
    const entryRef = db.collection("tournament_entries").doc(tSnap.get("entryId"));
    const stateRef = db.collection("tournament_players").doc(`${tSnap.get("tournamentId")}_${tSnap.get("playerId")}`);
    tx.create(dRef, { ticketId: tRef.id, chips: outcome.chips, scannedBy: c.uid, deviceId: c.deviceId ?? null, scannedAt: Timestamp.now() });
    tx.update(tRef, { status: "used" });
    const counters: Record<string, FieldValue> = { "counters.pendingChipDeliveries": FieldValue.increment(-1), "counters.chipDeliveries": FieldValue.increment(1) };
    if (kind === "buy_in" || kind === "reentry") {
      tx.update(entryRef, { status: "entered", enteredAt: FieldValue.serverTimestamp() });
      tx.set(stateRef, { hasActiveEntry: true, hasUndeliveredEntry: false }, { merge: true });
      counters["counters.entered"] = FieldValue.increment(1);
    }
    tx.update(db.collection("tournaments").doc(tSnap.get("tournamentId")), counters);
    audit(tx, { actor: c.uid, action: "chips.deliver", entity: dRef.path, deviceId: c.deviceId });
    return outcome;
  });
});
