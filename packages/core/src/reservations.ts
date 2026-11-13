import { dateBookability, type BookingCalendarSettings } from "./calendar.js";
import type { LocalDate } from "./time.js";

export type ReservationStatus = "reserved" | "checked_in" | "seated" | "cancelled" | "expired" | "no_show";
export const ACTIVE_RESERVATION: readonly ReservationStatus[] = ["reserved", "checked_in", "seated"];

export interface TableDayState {
  tableId: string;
  date: LocalDate;
  status: "open" | "closed";
  capacity: number;
  /** Reservations in an active status (reserved, checked-in, seated) — walk-ins included. */
  activeCount: number;
  /** Places held by pending waiting-list offers. */
  heldCount: number;
  cutoffAt: number;
}

export function placesAvailable(t: TableDayState): number {
  return Math.max(0, t.capacity - t.activeCount - t.heldCount);
}

export type ReserveDecision =
  | { ok: true }
  | { ok: false; code: "TABLE_CLOSED" | "CLOSED_DATE" | "NOT_OPEN_YET" | "PAST_CUTOFF" | "ALREADY_RESERVED_THIS_DATE" | "TABLE_FULL"; message: string };

/**
 * Validates a cash-game reservation request.
 * The backend runs this inside a transaction that also locks the table-day doc and
 * the (player, date) guard doc, so two requests can't both pass.
 */
export function checkReservation(input: {
  table: TableDayState;
  playerHasActiveReservationOnDate: boolean;
  nowMs: number;
  calendar: BookingCalendarSettings;
  /** Staff may book outside the public window (still not past cut-off). */
  staffOverride?: boolean;
}): ReserveDecision {
  const { table, nowMs, calendar } = input;
  if (table.status !== "open") return { ok: false, code: "TABLE_CLOSED", message: "This table is not open on that date." };
  const b = dateBookability(table.date, nowMs, calendar, table.cutoffAt);
  if (b === "closed_date") return { ok: false, code: "CLOSED_DATE", message: "Cash games are closed on that date." };
  if (b === "not_open_yet" && !input.staffOverride)
    return { ok: false, code: "NOT_OPEN_YET", message: "Reservations for that date are not open yet." };
  if (b === "past_cutoff") return { ok: false, code: "PAST_CUTOFF", message: "The reservation cut-off for that table has passed." };
  if (input.playerHasActiveReservationOnDate)
    return { ok: false, code: "ALREADY_RESERVED_THIS_DATE", message: "You already have a cash-game reservation on that date." };
  if (placesAvailable(table) < 1) return { ok: false, code: "TABLE_FULL", message: "This table is full. You can join the waiting list." };
  return { ok: true };
}

/** Only un-checked-in reservations expire at the cut-off. */
export function shouldExpireAtCutoff(status: ReservationStatus, cutoffAt: number, nowMs: number): boolean {
  return status === "reserved" && nowMs >= cutoffAt;
}

/**
 * Changing capacity. Returns how many places were released (for the waiting-list
 * engine) or an error if the new capacity is below current occupancy.
 */
export function changeCapacity(t: TableDayState, newCapacity: number): { ok: true; released: number } | { ok: false; message: string } {
  if (!Number.isInteger(newCapacity) || newCapacity < 1 || newCapacity > 12)
    return { ok: false, message: "Capacity must be between 1 and 12." };
  const occupied = t.activeCount + t.heldCount;
  if (newCapacity < occupied) return { ok: false, message: `Cannot reduce below ${occupied} occupied/held places.` };
  const before = placesAvailable(t);
  const after = newCapacity - occupied;
  return { ok: true, released: Math.max(0, after - before) };
}
