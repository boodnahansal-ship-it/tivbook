import { addDays, changeCapacity, DEFAULT_CALENDAR, instantToMuDate, muToInstant, orderQueue, weekday, type BookingCalendarSettings, type PriorityPolicy, type WaitingEntry } from "@tivbook/core";
import { STAFF, type Ctx, type Handler } from "../context.js";
import { ApiError, assertStaffDevice, audit, denied, fail, getSetting, isoDate, isUniqueViolation, ms, requireRole, signedIn, str } from "../util.js";
import { offerNextPlace, runScheduledJobs } from "./cash.js";

const HOURS = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAYS_AHEAD = 14;

/* ───────── Tables (Manager) ───────── */

export const upsertCashTable: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.admin);
  const name = str(d.name, "Table name", 40);
  const tableId = typeof d.tableId === "string" && d.tableId ? d.tableId : name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "TABLE";
  const cents = (v: unknown, label: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) fail("INVALID_ARGUMENT", `${label} must be a whole amount.`);
    return n;
  };
  const minBuyIn = cents(d.minBuyInCents, "Minimum buy-in");
  const maxBuyIn = cents(d.maxBuyInCents, "Maximum buy-in");
  if (maxBuyIn < minBuyIn) fail("INVALID_ARGUMENT", "Maximum buy-in must be at least the minimum.");
  const capacity = Number(d.defaultCapacity ?? 9);
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 12) fail("INVALID_ARGUMENT", "Seats must be between 2 and 12.");
  const openTime = String(d.openTime ?? "19:00");
  const cutoffTime = String(d.cutoffTime ?? "21:00");
  if (!HOURS.test(openTime) || !HOURS.test(cutoffTime)) fail("INVALID_ARGUMENT", "Times must look like 19:00.");
  const weekdays = Array.isArray(d.weekdays) ? [...new Set(d.weekdays.map(Number).filter((n) => n >= 0 && n <= 6))].sort() : [0, 1, 2, 3, 4, 5, 6];
  if (!weekdays.length) fail("INVALID_ARGUMENT", "Choose at least one day.");
  const active = d.active !== false;

  await ctx.sql`insert into cash_tables (table_id, name, game_type, small_blind_cents, big_blind_cents, min_buy_in_cents, max_buy_in_cents,
      default_capacity, active, open_time, cutoff_time, weekdays, sort_order)
    values (${tableId}, ${name}, ${String(d.gameType ?? "NLH").slice(0, 20)}, ${cents(d.smallBlindCents ?? 0, "Small blind")}, ${cents(d.bigBlindCents ?? 0, "Big blind")},
      ${minBuyIn}, ${maxBuyIn}, ${capacity}, ${active}, ${openTime}, ${cutoffTime}, ${weekdays}, ${Number(d.sortOrder ?? 0) | 0})
    on conflict (table_id) do update set name = excluded.name, game_type = excluded.game_type, small_blind_cents = excluded.small_blind_cents,
      big_blind_cents = excluded.big_blind_cents, min_buy_in_cents = excluded.min_buy_in_cents, max_buy_in_cents = excluded.max_buy_in_cents,
      default_capacity = excluded.default_capacity, active = excluded.active, open_time = excluded.open_time, cutoff_time = excluded.cutoff_time,
      weekdays = excluded.weekdays, sort_order = excluded.sort_order`;
  // Keep upcoming days that have no bookings in line with the new settings.
  await ctx.sql`update table_days set table_name = ${name}, open_time = ${openTime}
    where table_id = ${tableId} and date >= ${instantToMuDate(ctx.now())}`;
  await audit(ctx.sql, { actor: c.uid, action: "table.upsert", entity: `cash_tables/${tableId}`, after: { name, minBuyIn, maxBuyIn, capacity, weekdays, active }, deviceId: c.deviceId });
  await ensureTableDays(ctx);
  return { tableId };
};

/** Creates the next 14 days of each active table (run by the every-minute timer too). Never removes booked days. */
export async function ensureTableDays(ctx: Ctx): Promise<number> {
  const today = instantToMuDate(ctx.now());
  const tables = await ctx.sql`select * from cash_tables where active`;
  const calendar = await getSetting<BookingCalendarSettings>(ctx.sql, "booking_calendar", DEFAULT_CALENDAR);
  let created = 0;
  for (const t of tables) {
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const date = addDays(today, i);
      if (!(t.weekdays as number[]).includes(weekday(date)) || calendar.closedDates.includes(date)) continue;
      const cutoff = new Date(muToInstant(date, t.cutoff_time));
      const r = await ctx.sql`insert into table_days (id, table_id, table_name, date, capacity, cutoff_at, open_time)
        values (${`${t.table_id}_${date}`}, ${t.table_id}, ${t.name}, ${date}, ${t.default_capacity}, ${cutoff}, ${t.open_time})
        on conflict (id) do nothing`;
      created += r.count;
    }
  }
  return created;
}

/** Manager / floor: open or close a table for one day, or change its seats. */
export const setTableDay: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.floorSupervisor);
  const id = str(d.tableDayId, "tableDayId", 80);
  let released = 0;
  await ctx.sql.begin(async (tx) => {
    const [t] = await tx`select * from table_days where id = ${id} for update`;
    if (!t) throw new ApiError("NOT_FOUND", "Table not found for that date.", 404);
    if (d.status === "open" || d.status === "closed") await tx`update table_days set status = ${d.status} where id = ${id}`;
    if (d.capacity !== undefined) {
      const r = changeCapacity({ tableId: t.table_id, date: isoDate(t.date), status: t.status, capacity: t.capacity, activeCount: t.active_count, heldCount: t.held_count, cutoffAt: ms(t.cutoff_at) }, Number(d.capacity));
      if (!r.ok) fail("CAPACITY", r.message);
      await tx`update table_days set capacity = ${Number(d.capacity)} where id = ${id}`;
      released = r.released;
    }
    await audit(tx, { actor: c.uid, action: "tableday.update", entity: `table_days/${id}`, before: { status: t.status, capacity: t.capacity }, after: { status: d.status, capacity: d.capacity }, deviceId: c.deviceId });
  });
  const offers = released > 0 || d.status === "open" ? await offerNextPlace(ctx, id) : 0;
  return { ok: true, offersCreated: offers };
};

/** Manager: weekly booking opening and closed dates. */
export const setBookingCalendar: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.admin);
  const cur = await getSetting<BookingCalendarSettings>(ctx.sql, "booking_calendar", DEFAULT_CALENDAR);
  const openWeekday = d.openWeekday === undefined ? cur.openWeekday : Number(d.openWeekday);
  const openTime = d.openTime === undefined ? cur.openTime : String(d.openTime);
  if (!(openWeekday >= 0 && openWeekday <= 6) || !HOURS.test(openTime)) fail("INVALID_ARGUMENT", "Invalid opening day or time.");
  const closedDates = Array.isArray(d.closedDates) ? d.closedDates.map(String).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort() : cur.closedDates;
  const value: BookingCalendarSettings = { ...cur, openWeekday, openTime, closedDates };
  await ctx.sql`insert into settings (key, value) values ('booking_calendar', ${ctx.sql.json(value as never)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  await ctx.sql`update table_days set status = 'closed' where date = any(${closedDates}::date[]) and active_count = 0`;
  await audit(ctx.sql, { actor: c.uid, action: "calendar.update", entity: "settings/booking_calendar", after: value, deviceId: c.deviceId });
  return value;
};

/* ───────── Floor: arrival and seating ───────── */

export const checkInReservation: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.reservations);
  const id = str(d.reservationId, "reservationId", 40);
  const r = await ctx.sql`update cash_reservations set status = 'checked_in', checked_in_at = now() where id = ${id} and status = 'reserved' returning id`;
  if (!r.count) fail("NOT_RESERVED", "This booking is not waiting for check-in.");
  await audit(ctx.sql, { actor: c.uid, action: "reservation.checkin", entity: `cash_reservations/${id}`, deviceId: c.deviceId });
  return { ok: true };
};

/** Puts a checked-in (or reserved) player on a physical seat, or moves them to another seat. */
export const seatPlayer: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.floorSupervisor);
  const id = str(d.reservationId, "reservationId", 40);
  const seat = Number(d.seat);
  try {
    await ctx.sql.begin(async (tx) => {
      const [res] = await tx`select r.*, t.capacity from cash_reservations r join table_days t on t.id = r.table_day_id where r.id = ${id}`;
      if (!res) throw new ApiError("NOT_FOUND", "Booking not found.", 404);
      if (!["reserved", "checked_in", "seated"].includes(res.status)) fail("NOT_ACTIVE", "This booking is no longer active.");
      if (!Number.isInteger(seat) || seat < 1 || seat > res.capacity) fail("INVALID_SEAT", `Seat must be between 1 and ${res.capacity}.`);
      await tx`update cash_reservations set status = 'seated', seat = ${seat}, seated_at = coalesce(seated_at, now()),
        checked_in_at = coalesce(checked_in_at, now()) where id = ${id}`;
      await audit(tx, { actor: c.uid, action: "reservation.seat", entity: `cash_reservations/${id}`, after: { seat }, deviceId: c.deviceId });
    });
  } catch (e) {
    if (isUniqueViolation(e, "one_player_per_seat")) fail("SEAT_TAKEN", "That seat is already taken.");
    throw e;
  }
  return { ok: true };
};

/** Player leaves the table: the place is released and the next waiting player is alarmed. */
export const leaveTable: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.floorSupervisor);
  const id = str(d.reservationId, "reservationId", 40);
  const tableDayId = await ctx.sql.begin(async (tx) => {
    const [pre] = await tx`select table_day_id from cash_reservations where id = ${id}`;
    if (!pre) throw new ApiError("NOT_FOUND", "Booking not found.", 404);
    await tx`select 1 from table_days where id = ${pre.table_day_id} for update`;
    const [r] = await tx`update cash_reservations set status = ${d.noShow === true ? "no_show" : "left"}, released_at = now(), released_by = ${c.uid}
      where id = ${id} and status in ('reserved','checked_in','seated') returning table_day_id`;
    if (!r) fail("NOT_ACTIVE", "This booking is no longer active.");
    await tx`update table_days set active_count = active_count - 1 where id = ${r!.table_day_id}`;
    await audit(tx, { actor: c.uid, action: d.noShow === true ? "reservation.no_show" : "reservation.left", entity: `cash_reservations/${id}`, deviceId: c.deviceId });
    return r!.table_day_id as string;
  });
  return { ok: true, offersCreated: await offerNextPlace(ctx, tableDayId) };
};

/* ───────── Waiting list ───────── */

/** Leave a waiting list (the player themself, or staff). A pending offer is given back. */
export const leaveWaitingList: Handler = async (ctx, d) => {
  const c = signedIn(ctx);
  const id = str(d.waitingEntryId, "waitingEntryId", 40);
  if (c.role !== "player") {
    if (!STAFF.reservations.includes(c.role)) denied();
    await assertStaffDevice(ctx.sql, c);
  }
  const tableDayId = await ctx.sql.begin(async (tx) => {
    const [w] = await tx`select * from waiting_lists where id = ${id}`;
    if (!w) throw new ApiError("NOT_FOUND", "Waiting-list entry not found.", 404);
    if (c.role === "player" && w.player_id !== c.playerId) denied();
    await tx`select 1 from table_days where id = ${w.table_day_id} for update`;
    const [cur] = await tx`update waiting_lists set status = 'cancelled' where id = ${id} and status in ('waiting','offered') returning status`;
    if (!cur) fail("NOT_WAITING", "You are no longer on this waiting list.");
    let releaseHold = 0;
    if (w.status === "offered" && w.current_offer_id) {
      const o = await tx`update waiting_offers set status = 'cancelled' where id = ${w.current_offer_id} and status = 'pending'`;
      releaseHold = o.count;
    }
    await tx`update table_days set waiting_count = waiting_count - 1, held_count = held_count - ${releaseHold} where id = ${w.table_day_id}`;
    return releaseHold ? (w.table_day_id as string) : null;
  });
  if (tableDayId) await offerNextPlace(ctx, tableDayId);
  return { ok: true };
};

/** Queue positions for the signed-in player ("You are #2 on the list"). */
export const myWaitingPositions: Handler = async (ctx) => {
  const c = signedIn(ctx);
  if (c.role !== "player" || !c.playerId) denied();
  const mine = await ctx.sql`select w.id, w.table_day_id, t.waiting_policy, t.last_served_type from waiting_lists w join table_days t on t.id = w.table_day_id
    where w.player_id = ${c.playerId!} and w.status = 'waiting'`;
  const settings = await getSetting<{ policy: PriorityPolicy }>(ctx.sql, "waiting_list", { policy: "fifo" });
  const out: Record<string, number> = {};
  for (const m of mine) {
    const rows = await ctx.sql`select id, player_id, list_type, requested_at, status, priority_override from waiting_lists where table_day_id = ${m.table_day_id} and status = 'waiting'`;
    const entries: WaitingEntry[] = rows.map((r) => ({ id: r.id, playerId: r.player_id, listType: r.list_type, requestedAt: ms(r.requested_at), status: r.status, priorityOverride: r.priority_override }));
    const order = orderQueue(entries, (m.waiting_policy as PriorityPolicy) ?? settings.policy, m.last_served_type ?? undefined);
    out[m.id] = order.findIndex((e) => e.id === m.id) + 1;
  }
  return { positions: out };
};

/** Every minute: create upcoming table days, then expire bookings/offers and alarm the next players. */
export const cronTick: Handler = async (ctx) => {
  if (!ctx.cronAuthorized) denied("Scheduled job only.");
  const createdDays = await ensureTableDays(ctx);
  return { createdDays, ...(await runScheduledJobs(ctx)) };
};
