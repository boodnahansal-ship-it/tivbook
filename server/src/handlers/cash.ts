import {
  DEFAULT_CALENDAR, DEFAULT_OFFER_MINUTES, checkReservation, newOfferTimes, placeAvailableMessage, placesAvailable,
  respondToOffer, selectNext, type BookingCalendarSettings, type ListType, type PriorityPolicy, type TableDayState, type WaitingEntry,
} from "@tivbook/core";
import { STAFF, type Ctx, type Handler, type Tx } from "../context.js";
import { ApiError, assertStaffDevice, audit, denied, fail, getSetting, isoDate, isUniqueViolation, ms, requireRole, resolvePlayerId, signedIn, str } from "../util.js";

interface WaitingSettings { policy: PriorityPolicy; offerMinutes: number }
const DEFAULT_WAITING: WaitingSettings = { policy: "fifo", offerMinutes: DEFAULT_OFFER_MINUTES };

function tableState(r: Record<string, unknown> | undefined): TableDayState {
  if (!r) throw new ApiError("TABLE_NOT_FOUND", "Table not found for that date.", 404);
  return {
    tableId: r.table_id as string, date: isoDate(r.date), status: r.status as "open" | "closed", capacity: r.capacity as number,
    activeCount: r.active_count as number, heldCount: r.held_count as number, cutoffAt: ms(r.cutoff_at),
  };
}

async function hasActiveReservation(tx: Tx, playerId: string, date: string) {
  const [r] = await tx`select 1 from cash_reservations where player_id = ${playerId} and date = ${date} and status in ('reserved','checked_in','seated')`;
  return !!r;
}

/* ───────── Reservations ───────── */

export const reserveCashPlace: Handler = async (ctx, d) => {
  const c = signedIn(ctx);
  const tableDayId = str(d.tableDayId, "tableDayId", 80);
  const playerId = await resolvePlayerId(ctx, d.playerId, STAFF.reservations);
  const calendar = await getSetting<BookingCalendarSettings>(ctx.sql, "booking_calendar", DEFAULT_CALENDAR);
  try {
    return await ctx.sql.begin(async (tx) => {
      const [row] = await tx`select * from table_days where id = ${tableDayId} for update`;
      const table = tableState(row);
      const decision = checkReservation({
        table, calendar, nowMs: ctx.now(), staffOverride: c.role !== "player",
        playerHasActiveReservationOnDate: await hasActiveReservation(tx, playerId, table.date),
      });
      if (!decision.ok) fail(decision.code, decision.message);
      const [res] = await tx`insert into cash_reservations (player_id, table_day_id, table_id, date, status, cutoff_at, source, created_by)
        values (${playerId}, ${tableDayId}, ${table.tableId}, ${table.date}, 'reserved', ${new Date(table.cutoffAt)},
                ${c.role === "player" ? "app" : c.role}, ${c.uid}) returning id`;
      await tx`update table_days set active_count = active_count + 1 where id = ${tableDayId}`;
      await audit(tx, { actor: c.uid, action: "reservation.create", entity: `cash_reservations/${res!.id}`, deviceId: c.deviceId });
      return { reservationId: res!.id as string };
    });
  } catch (e) {
    if (isUniqueViolation(e, "one_reservation_per_date")) fail("ALREADY_RESERVED_THIS_DATE", "You already have a cash-game reservation on that date.");
    throw e;
  }
};

/** Lock order everywhere: table_days row first, then the rows that depend on it (prevents deadlocks). */
async function release(tx: Tx, id: string, status: "cancelled" | "expired" | "no_show" | "left", actor: string, expectStatus?: string) {
  const [pre] = await tx`select table_day_id from cash_reservations where id = ${id}`;
  if (!pre) return undefined;
  await tx`select 1 from table_days where id = ${pre.table_day_id} for update`;
  const [r] = await tx`update cash_reservations set status = ${status}, released_at = now(), released_by = ${actor}
    where id = ${id} and status = any(${expectStatus ? [expectStatus] : ["reserved", "checked_in", "seated"]}::text[]) returning table_day_id`;
  if (r) await tx`update table_days set active_count = active_count - 1 where id = ${r.table_day_id}`;
  return r?.table_day_id as string | undefined;
}

export const cancelCashReservation: Handler = async (ctx, d) => {
  const c = signedIn(ctx);
  const id = str(d.reservationId, "reservationId", 40);
  if (c.role !== "player") {
    if (!STAFF.reservations.includes(c.role)) denied();
    await assertStaffDevice(ctx.sql, c);
  }
  const tableDayId = await ctx.sql.begin(async (tx) => {
    const [res] = await tx`select * from cash_reservations where id = ${id}`;
    if (!res) throw new ApiError("NOT_FOUND", "Reservation not found.", 404);
    if (c.role === "player" && res.player_id !== c.playerId) denied("Not your reservation.");
    if (!["reserved", "checked_in"].includes(res.status)) fail("NOT_ACTIVE", "This reservation is no longer active.");
    const t = await release(tx, id, "cancelled", c.uid);
    if (!t) fail("NOT_ACTIVE", "This reservation is no longer active.");
    await audit(tx, { actor: c.uid, action: "reservation.cancel", entity: `cash_reservations/${id}`, deviceId: c.deviceId });
    return t!;
  });
  await offerNextPlace(ctx, tableDayId);
  return { ok: true };
};

/* ───────── Waiting lists & Place-available alarms ───────── */

export const joinWaitingList: Handler = async (ctx, d) => {
  const tableDayId = str(d.tableDayId, "tableDayId", 80);
  const playerId = await resolvePlayerId(ctx, d.playerId, STAFF.reservations);
  const listType: ListType = d.listType === "movement" ? "movement" : "new_player";
  if (listType === "movement" && !d.movementRequestId) fail("MOVEMENT_REQUIRED", "A movement request is required.");
  try {
    return await ctx.sql.begin(async (tx) => {
      const [row] = await tx`select * from table_days where id = ${tableDayId} for update`;
      const table = tableState(row);
      if (listType === "new_player" && (await hasActiveReservation(tx, playerId, table.date)))
        fail("ALREADY_RESERVED_THIS_DATE", "You already have a reservation that date. Use a table movement request instead.");
      const [w] = await tx`insert into waiting_lists (table_day_id, player_id, list_type, movement_request_id, requested_at, status)
        values (${tableDayId}, ${playerId}, ${listType}, ${(d.movementRequestId as string) ?? null}, ${new Date(ctx.now())}, 'waiting') returning id`;
      await tx`update table_days set waiting_count = waiting_count + 1 where id = ${tableDayId}`;
      return { waitingEntryId: w!.id as string };
    });
  } catch (e) {
    if (isUniqueViolation(e, "one_waiting_entry")) fail("ALREADY_WAITING", "You are already on this waiting list.");
    throw e;
  }
};

/**
 * If a place is free and someone is waiting, creates ONE offer and holds the place
 * (row lock on the table-day, so two releases can never offer the same place twice).
 * Repeats while places remain. Sends the alarm push after each commit.
 */
export async function offerNextPlace(ctx: Ctx, tableDayId: string): Promise<number> {
  const settings = await getSetting<WaitingSettings>(ctx.sql, "waiting_list", DEFAULT_WAITING);
  let created = 0;
  for (let i = 0; i < 12; i++) {
    const offer = await ctx.sql.begin(async (tx) => {
      const [row] = await tx`select * from table_days where id = ${tableDayId} for update`;
      const table = tableState(row);
      if (table.status !== "open" || placesAvailable(table) < 1 || ctx.now() >= table.cutoffAt) return null;
      const rows = await tx`select w.*, exists (select 1 from cash_reservations r where r.player_id = w.player_id and r.date = ${table.date}
          and r.status in ('reserved','checked_in','seated')) as has_res
        from waiting_lists w where w.table_day_id = ${tableDayId} and w.status = 'waiting'`;
      const entries: Array<WaitingEntry & { hasRes: boolean }> = rows.map((r) => ({
        id: r.id, playerId: r.player_id, listType: r.list_type, requestedAt: ms(r.requested_at), status: r.status, priorityOverride: r.priority_override, hasRes: r.has_res,
      }));
      const policy = (row!.waiting_policy as PriorityPolicy) ?? settings.policy;
      const next = selectNext(entries, policy, (e) => !(e.listType === "new_player" && (e as unknown as { hasRes: boolean }).hasRes), (row!.last_served_type as ListType) ?? undefined);
      if (!next) return null;
      const minutes = Number(row!.offer_minutes ?? settings.offerMinutes);
      const t = newOfferTimes(ctx.now(), minutes);
      const [o] = await tx`insert into waiting_offers (waiting_entry_id, table_day_id, player_id, list_type, status, created_at, expires_at)
        values (${next.id}, ${tableDayId}, ${next.playerId}, ${next.listType}, 'pending', ${new Date(t.createdAt)}, ${new Date(t.expiresAt)}) returning id`;
      await tx`update waiting_lists set status = 'offered', current_offer_id = ${o!.id} where id = ${next.id}`;
      await tx`update table_days set held_count = held_count + 1, last_served_type = ${next.listType} where id = ${tableDayId}`;
      return { id: o!.id as string, playerId: next.playerId, listType: next.listType, expiresAt: t.expiresAt, tableName: row!.table_name as string };
    });
    if (!offer) break;
    created++;
    const tokens = (await ctx.sql`select token from player_devices where player_id = ${offer.playerId}`).map((r) => r.token as string);
    const msg = placeAvailableMessage(offer.listType, offer.tableName);
    const delivery = tokens.length
      ? await ctx.services.push.send(tokens, { ...msg, channel: "place_available", data: { type: "place_offer", offerId: offer.id, expiresAt: String(offer.expiresAt) } }).catch(() => ({ sent: 0, failed: tokens.length }))
      : { sent: 0, failed: 0 };
    await ctx.sql`update waiting_offers set notifications = notifications || ${ctx.sql.json([{ at: ctx.now(), ...delivery }])} where id = ${offer.id}`;
  }
  return created;
}

export const respondPlaceOffer: Handler = async (ctx, d) => {
  const c = signedIn(ctx);
  if (c.role !== "player" || !c.playerId) denied("Players only.");
  const offerId = str(d.offerId, "offerId", 40);
  const action = d.action;
  if (action !== "accept" && action !== "decline") fail("INVALID_ARGUMENT", "action must be accept or decline.");

  const result = await ctx.sql.begin(async (tx) => {
    const [o] = await tx`select * from waiting_offers where id = ${offerId}`;
    if (!o) throw new ApiError("NOT_FOUND", "Offer not found.", 404);
    const [row] = await tx`select * from table_days where id = ${o.table_day_id} for update`;
    const [offer] = await tx`select * from waiting_offers where id = ${offerId} for update`;
    const r = respondToOffer(
      { id: offer!.id, waitingEntryId: offer!.waiting_entry_id, playerId: offer!.player_id, tableDayId: offer!.table_day_id, createdAt: ms(offer!.created_at), expiresAt: ms(offer!.expires_at), status: offer!.status },
      c.playerId!, action as "accept" | "decline", ctx.now(),
    );
    if (!r.ok) fail(r.code, r.message);
    const table = tableState(row);
    const [w] = await tx`select * from waiting_lists where id = ${offer!.waiting_entry_id} for update`;
    await tx`update waiting_offers set status = ${r.status}, responded_at = now() where id = ${offerId}`;
    if (r.status === "declined") {
      await tx`update waiting_lists set status = 'declined' where id = ${w!.id}`;
      await tx`update table_days set held_count = held_count - 1, waiting_count = waiting_count - 1 where id = ${row!.id}`;
      return { status: "declined" as const, tableDayId: row!.id as string };
    }
    if (w!.list_type === "new_player") {
      if (await hasActiveReservation(tx, c.playerId!, table.date)) fail("ALREADY_RESERVED_THIS_DATE", "You already have a reservation that date.");
      const [res] = await tx`insert into cash_reservations (player_id, table_day_id, table_id, date, status, cutoff_at, source, offer_id, created_by)
        values (${c.playerId!}, ${row!.id}, ${table.tableId}, ${table.date}, 'reserved', ${new Date(table.cutoffAt)}, 'waiting_list', ${offerId}, ${c.uid}) returning id`;
      await tx`update waiting_lists set status = 'fulfilled' where id = ${w!.id}`;
      await tx`update table_days set held_count = held_count - 1, active_count = active_count + 1, waiting_count = waiting_count - 1 where id = ${row!.id}`;
      return { status: "accepted" as const, reservationId: res!.id as string };
    }
    // Movement: the hold stays; the original seat is kept until the floor completes the move.
    await tx`update waiting_lists set status = 'accepted' where id = ${w!.id}`;
    await tx`update table_movement_requests set status = 'pending_financial_verification', offer_id = ${offerId},
      history = history || ${tx.json([{ at: ctx.now(), status: "pending_financial_verification", by: c.uid }])} where id = ${w!.movement_request_id}`;
    return { status: "accepted" as const, movement: true };
  });
  if (result.status === "declined") await offerNextPlace(ctx, result.tableDayId);
  return result;
};

/** Floor: a place has become free (player left, table opened up). Starts the alarm chain. */
export const notifyPlaceReleased: Handler = async (ctx, d) => {
  await requireRole(ctx, STAFF.floorSupervisor);
  return { offersCreated: await offerNextPlace(ctx, str(d.tableDayId, "tableDayId", 80)) };
};

/* ───────── Every minute (scheduled) ───────── */

export async function runScheduledJobs(ctx: Ctx) {
  const now = new Date(ctx.now());
  const tables = new Set<string>();
  // 1. Un-checked-in reservations past the table cut-off expire.
  const due = await ctx.sql`select id from cash_reservations where status = 'reserved' and cutoff_at <= ${now} limit 500`;
  for (const r of due) {
    const t = await ctx.sql.begin((tx) => release(tx, r.id, "expired", "system", "reserved"));
    if (t) tables.add(t);
  }
  // 2. Overdue offers expire and the hold is released.
  const offers = await ctx.sql`select id, table_day_id from waiting_offers where status = 'pending' and expires_at <= ${now} limit 500`;
  for (const o of offers) {
    await ctx.sql.begin(async (tx) => {
      await tx`select 1 from table_days where id = ${o.table_day_id} for update`;
      const [x] = await tx`update waiting_offers set status = 'expired' where id = ${o.id} and status = 'pending' and expires_at <= ${now}
        returning waiting_entry_id, table_day_id`;
      if (!x) return;
      await tx`update waiting_lists set status = 'expired' where id = ${x.waiting_entry_id}`;
      await tx`update table_days set held_count = held_count - 1, waiting_count = waiting_count - 1 where id = ${x.table_day_id}`;
      tables.add(x.table_day_id);
    });
  }
  // 3. Offer the freed places to the next players.
  let offered = 0;
  for (const t of tables) offered += await offerNextPlace(ctx, t);
  return { expiredReservations: due.length, expiredOffers: offers.length, newOffers: offered };
}

export const cronTick: Handler = async (ctx) => {
  if (!ctx.cronAuthorized) denied("Scheduled job only.");
  return runScheduledJobs(ctx);
};
