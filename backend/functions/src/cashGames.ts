import { FieldValue, Timestamp, type DocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import {
  DEFAULT_CALENDAR, DEFAULT_OFFER_MINUTES, checkReservation, newOfferTimes, placeAvailableMessage, placesAvailable,
  respondToOffer, selectNext, shouldExpireAtCutoff,
  type BookingCalendarSettings, type ListType, type Offer, type PriorityPolicy, type TableDayState, type WaitingEntry,
} from "@tivbook/core";
import { assertStaffDevice, audit, caller, db, fail, getSettings, pushToPlayer, REGION, requireRole, resolvePlayerId, STAFF, str } from "./lib.js";

interface WaitingSettings { policy: PriorityPolicy; offerMinutes: number }
const DEFAULT_WAITING: WaitingSettings = { policy: "fifo", offerMinutes: DEFAULT_OFFER_MINUTES };

const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : Number(v));

function tableState(s: DocumentSnapshot): TableDayState {
  if (!s.exists) fail("TABLE_NOT_FOUND", "Table not found for that date.");
  return {
    tableId: s.get("tableId"),
    date: s.get("date"),
    status: s.get("status"),
    capacity: s.get("capacity"),
    activeCount: s.get("activeCount") ?? 0,
    heldCount: s.get("heldCount") ?? 0,
    cutoffAt: ms(s.get("cutoffAt")),
  };
}

const guardRef = (playerId: string, date: string) => db.collection("reservation_guards").doc(`${playerId}_${date}`);

/* ───────────────────────── Reservations ───────────────────────── */

export const reserveCashPlace = onCall({ region: REGION }, async (req) => {
  const c = caller(req);
  const d = (req.data ?? {}) as { tableDayId?: string; playerId?: string };
  const tableDayId = str(d.tableDayId, "tableDayId");
  const playerId = await resolvePlayerId(c, d.playerId, STAFF.reservations);
  const calendar = await getSettings<BookingCalendarSettings>("booking_calendar/settings", DEFAULT_CALENDAR);
  const tableRef = db.collection("table_days").doc(tableDayId);

  return db.runTransaction(async (tx) => {
    const tSnap = await tx.get(tableRef);
    const table = tableState(tSnap);
    const gRef = guardRef(playerId, table.date);
    const guard = await tx.get(gRef);
    const decision = checkReservation({
      table, calendar, nowMs: Date.now(),
      playerHasActiveReservationOnDate: guard.exists,
      staffOverride: c.role !== "player",
    });
    if (!decision.ok) fail(decision.code, decision.message);
    const resRef = db.collection("cash_reservations").doc();
    tx.create(resRef, {
      playerId, tableDayId, tableId: table.tableId, date: table.date, status: "reserved",
      cutoffAt: Timestamp.fromMillis(table.cutoffAt), source: c.role === "player" ? "app" : c.role,
      createdAt: FieldValue.serverTimestamp(), createdBy: c.uid,
    });
    tx.create(gRef, { reservationId: resRef.id, tableDayId });
    tx.update(tableRef, { activeCount: FieldValue.increment(1) });
    audit(tx, { actor: c.uid, action: "reservation.create", entity: `cash_reservations/${resRef.id}`, deviceId: c.deviceId });
    return { reservationId: resRef.id };
  });
});

/** Shared release: cancel / expire / leave. Keeps counters and guard consistent. */
function releaseReservation(tx: Transaction, res: DocumentSnapshot, status: "cancelled" | "expired" | "no_show" | "left", actor: string) {
  tx.update(res.ref, { status, releasedAt: FieldValue.serverTimestamp(), releasedBy: actor });
  tx.delete(guardRef(res.get("playerId"), res.get("date")));
  tx.update(db.collection("table_days").doc(res.get("tableDayId")), { activeCount: FieldValue.increment(-1) });
}

export const cancelCashReservation = onCall({ region: REGION }, async (req) => {
  const c = caller(req);
  const reservationId = str((req.data as { reservationId?: string })?.reservationId, "reservationId");
  if (c.role !== "player") await assertStaffDevice(c);
  const ref = db.collection("cash_reservations").doc(reservationId);
  const tableDayId = await db.runTransaction(async (tx) => {
    const res = await tx.get(ref);
    if (!res.exists) fail("NOT_FOUND", "Reservation not found.");
    if (c.role === "player" && res.get("playerId") !== c.playerId) throw new HttpsError("permission-denied", "Not your reservation.");
    if (c.role !== "player" && !STAFF.reservations.includes(c.role)) throw new HttpsError("permission-denied", "Not allowed.");
    if (!["reserved", "checked_in"].includes(res.get("status"))) fail("NOT_ACTIVE", "This reservation is no longer active.");
    releaseReservation(tx, res, "cancelled", c.uid);
    audit(tx, { actor: c.uid, action: "reservation.cancel", entity: ref.path, deviceId: c.deviceId });
    return res.get("tableDayId") as string;
  });
  await offerNextPlace(tableDayId);
  return { ok: true };
});

/** Every minute: expire un-checked-in reservations past their table's cut-off. */
export const expireReservationsAtCutoff = onSchedule({ region: REGION, schedule: "every 1 minutes", timeZone: "Indian/Mauritius" }, async () => {
  const now = Date.now();
  const due = await db.collection("cash_reservations").where("status", "==", "reserved").where("cutoffAt", "<=", Timestamp.fromMillis(now)).limit(200).get();
  const tables = new Set<string>();
  for (const doc of due.docs) {
    await db.runTransaction(async (tx) => {
      const res = await tx.get(doc.ref);
      if (!shouldExpireAtCutoff(res.get("status"), ms(res.get("cutoffAt")), Date.now())) return;
      releaseReservation(tx, res, "expired", "system");
      tables.add(res.get("tableDayId"));
    });
  }
  for (const t of tables) await offerNextPlace(t);
  if (due.size) logger.info("reservations expired", { count: due.size });
});

/* ───────────────────────── Waiting lists ───────────────────────── */

export const joinWaitingList = onCall({ region: REGION }, async (req) => {
  const c = caller(req);
  const d = (req.data ?? {}) as { tableDayId?: string; playerId?: string; listType?: ListType; movementRequestId?: string };
  const tableDayId = str(d.tableDayId, "tableDayId");
  const playerId = await resolvePlayerId(c, d.playerId, STAFF.reservations);
  const listType: ListType = d.listType === "movement" ? "movement" : "new_player";

  return db.runTransaction(async (tx) => {
    const table = tableState(await tx.get(db.collection("table_days").doc(tableDayId)));
    const [dup, guard] = await Promise.all([
      tx.get(db.collection("waiting_lists").where("tableDayId", "==", tableDayId).where("playerId", "==", playerId).where("status", "in", ["waiting", "offered"]).limit(1)),
      tx.get(guardRef(playerId, table.date)),
    ]);
    if (!dup.empty) fail("ALREADY_WAITING", "You are already on this waiting list.");
    if (listType === "new_player" && guard.exists) fail("ALREADY_RESERVED_THIS_DATE", "You already have a reservation that date. Use a table movement request instead.");
    if (listType === "movement" && !d.movementRequestId) fail("MOVEMENT_REQUIRED", "A movement request is required.");
    const ref = db.collection("waiting_lists").doc();
    tx.create(ref, {
      tableDayId, playerId, listType, movementRequestId: d.movementRequestId ?? null,
      requestedAt: Timestamp.now(), status: "waiting", priorityOverride: null, notifications: [],
    });
    tx.update(db.collection("table_days").doc(tableDayId), { waitingCount: FieldValue.increment(1) });
    return { waitingEntryId: ref.id };
  });
});

function toEntry(s: DocumentSnapshot): WaitingEntry {
  return { id: s.id, playerId: s.get("playerId"), listType: s.get("listType"), requestedAt: ms(s.get("requestedAt")), status: s.get("status"), priorityOverride: s.get("priorityOverride") };
}

/**
 * If a place is free and someone is waiting, creates ONE temporary offer and holds
 * the place. Runs in a transaction so two releases can't double-offer the same place.
 * Loops while places remain (e.g. capacity increased by 2).
 */
export async function offerNextPlace(tableDayId: string): Promise<number> {
  const settings = await getSettings<WaitingSettings>("system_settings/waiting_list", DEFAULT_WAITING);
  let created = 0;
  for (let i = 0; i < 12; i++) {
    const offer = await db.runTransaction(async (tx) => {
      const tRef = db.collection("table_days").doc(tableDayId);
      const tSnap = await tx.get(tRef);
      const table = tableState(tSnap);
      if (table.status !== "open" || placesAvailable(table) < 1 || Date.now() >= table.cutoffAt) return null;
      const q = await tx.get(db.collection("waiting_lists").where("tableDayId", "==", tableDayId).where("status", "==", "waiting"));
      const entries = q.docs.map(toEntry);
      // Eligibility: a new player must not already hold a reservation that date.
      const guards = new Map<string, boolean>();
      for (const e of entries.filter((x) => x.listType === "new_player")) {
        guards.set(e.playerId, (await tx.get(guardRef(e.playerId, table.date))).exists);
      }
      const next = selectNext(entries, (tSnap.get("waitingPolicy") as PriorityPolicy) ?? settings.policy, (e) => !(e.listType === "new_player" && guards.get(e.playerId)), tSnap.get("lastServedType"));
      if (!next) return null;
      const minutes = (tSnap.get("offerMinutes") as number) ?? settings.offerMinutes;
      const times = newOfferTimes(Date.now(), minutes);
      const oRef = db.collection("waiting_offers").doc();
      tx.create(oRef, {
        waitingEntryId: next.id, tableDayId, playerId: next.playerId, listType: next.listType, status: "pending",
        createdAt: Timestamp.fromMillis(times.createdAt), expiresAt: Timestamp.fromMillis(times.expiresAt),
      });
      tx.update(db.collection("waiting_lists").doc(next.id), { status: "offered", currentOfferId: oRef.id });
      tx.update(tRef, { heldCount: FieldValue.increment(1), lastServedType: next.listType });
      return { id: oRef.id, playerId: next.playerId, listType: next.listType, expiresAt: times.expiresAt, tableName: (tSnap.get("tableName") as string) ?? table.tableId };
    });
    if (!offer) break;
    created++;
    const msg = placeAvailableMessage(offer.listType, offer.tableName);
    const delivery = await pushToPlayer(offer.playerId, {
      ...msg, channel: "place_available",
      data: { type: "place_offer", offerId: offer.id, expiresAt: String(offer.expiresAt) },
    }).catch((e) => ({ sent: 0, failed: 1, error: String(e) }));
    await db.collection("waiting_offers").doc(offer.id).update({ notifications: FieldValue.arrayUnion({ at: Date.now(), ...delivery }) });
  }
  return created;
}

export const respondPlaceOffer = onCall({ region: REGION }, async (req) => {
  const c = caller(req);
  const d = (req.data ?? {}) as { offerId?: string; action?: string };
  const offerId = str(d.offerId, "offerId");
  if (d.action !== "accept" && d.action !== "decline") throw new HttpsError("invalid-argument", "action must be accept or decline.");
  const action = d.action;
  if (!c.playerId) throw new HttpsError("permission-denied", "Players only.");

  const result = await db.runTransaction(async (tx) => {
    const oRef = db.collection("waiting_offers").doc(offerId);
    const oSnap = await tx.get(oRef);
    if (!oSnap.exists) fail("NOT_FOUND", "Offer not found.");
    const offer: Offer = {
      id: oSnap.id, waitingEntryId: oSnap.get("waitingEntryId"), playerId: oSnap.get("playerId"), tableDayId: oSnap.get("tableDayId"),
      createdAt: ms(oSnap.get("createdAt")), expiresAt: ms(oSnap.get("expiresAt")), status: oSnap.get("status"),
    };
    const r = respondToOffer(offer, c.playerId!, action, Date.now());
    if (!r.ok) fail(r.code, r.message);
    const tRef = db.collection("table_days").doc(offer.tableDayId);
    const table = tableState(await tx.get(tRef));
    const wRef = db.collection("waiting_lists").doc(offer.waitingEntryId);
    const wSnap = await tx.get(wRef);
    const listType = wSnap.get("listType") as ListType;
    const gRef = guardRef(offer.playerId, table.date);
    const guard = listType === "new_player" ? await tx.get(gRef) : null;

    tx.update(oRef, { status: r.status, respondedAt: FieldValue.serverTimestamp() });
    if (r.status === "declined") {
      tx.update(wRef, { status: "declined" });
      tx.update(tRef, { heldCount: FieldValue.increment(-1), waitingCount: FieldValue.increment(-1) });
      return { status: "declined" as const, release: true };
    }
    if (listType === "new_player") {
      if (guard?.exists) fail("ALREADY_RESERVED_THIS_DATE", "You already have a reservation that date.");
      const resRef = db.collection("cash_reservations").doc();
      tx.create(resRef, {
        playerId: offer.playerId, tableDayId: offer.tableDayId, tableId: table.tableId, date: table.date, status: "reserved",
        cutoffAt: Timestamp.fromMillis(table.cutoffAt), source: "waiting_list", offerId, createdAt: FieldValue.serverTimestamp(), createdBy: c.uid,
      });
      tx.create(gRef, { reservationId: resRef.id, tableDayId: offer.tableDayId });
      tx.update(wRef, { status: "fulfilled" });
      tx.update(tRef, { heldCount: FieldValue.increment(-1), activeCount: FieldValue.increment(1), waitingCount: FieldValue.increment(-1) });
      return { status: "accepted" as const, reservationId: resRef.id, release: false };
    }
    // Movement: keep the hold; the original seat stays until the floor completes the move.
    tx.update(wRef, { status: "accepted" });
    tx.update(db.collection("table_movement_requests").doc(wSnap.get("movementRequestId")), {
      status: "pending_financial_verification", offerId, history: FieldValue.arrayUnion({ at: Date.now(), status: "pending_financial_verification", by: c.uid }),
    });
    return { status: "accepted" as const, movement: true, release: false };
  });
  if (result.release) await offerNextPlace((await db.collection("waiting_offers").doc(offerId).get()).get("tableDayId"));
  return result;
});

/** Every minute: expire overdue offers, release holds, offer to the next player. */
export const expirePlaceOffers = onSchedule({ region: REGION, schedule: "every 1 minutes", timeZone: "Indian/Mauritius" }, async () => {
  const due = await db.collection("waiting_offers").where("status", "==", "pending").where("expiresAt", "<=", Timestamp.now()).limit(200).get();
  const tables = new Set<string>();
  for (const doc of due.docs) {
    await db.runTransaction(async (tx) => {
      const o = await tx.get(doc.ref);
      if (o.get("status") !== "pending" || ms(o.get("expiresAt")) > Date.now()) return;
      tx.update(o.ref, { status: "expired", expiredAt: FieldValue.serverTimestamp() });
      tx.update(db.collection("waiting_lists").doc(o.get("waitingEntryId")), { status: "expired" });
      tx.update(db.collection("table_days").doc(o.get("tableDayId")), { heldCount: FieldValue.increment(-1), waitingCount: FieldValue.increment(-1) });
      tables.add(o.get("tableDayId"));
    });
  }
  for (const t of tables) await offerNextPlace(t);
});

/** Floor: "a place is free" (player left, admin release). Triggers the alarm engine. */
export const notifyPlaceReleased = onCall({ region: REGION }, async (req) => {
  await requireRole(req, STAFF.floorSupervisor);
  const created = await offerNextPlace(str((req.data as { tableDayId?: string })?.tableDayId, "tableDayId"));
  return { offersCreated: created };
});
