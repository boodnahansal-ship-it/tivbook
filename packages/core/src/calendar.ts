import { addDays, muToInstant, weekday, type LocalDate, type LocalTime } from "./time.js";

/**
 * Weekly booking policy. Default: every Sunday at openTime, reservations open
 * for the following Monday–Sunday.
 */
export interface BookingCalendarSettings {
  /** First day of a booking week. 1 = Monday (default). */
  weekStartWeekday: number;
  /** Day reservations open. 0 = Sunday (default). */
  openWeekday: number;
  openTime: LocalTime;
  /** Dates when no cash games run. */
  closedDates: LocalDate[];
  /** Override the opening moment for a specific booking week, keyed by the week's first date. */
  openingOverrides: Record<LocalDate, { date: LocalDate; time: LocalTime }>;
}

export const DEFAULT_CALENDAR: BookingCalendarSettings = {
  weekStartWeekday: 1,
  openWeekday: 0,
  openTime: "10:00",
  closedDates: [],
  openingOverrides: {},
};

/** First date of the booking week containing `date`. */
export function bookingWeekStart(date: LocalDate, s: BookingCalendarSettings): LocalDate {
  const back = (weekday(date) - s.weekStartWeekday + 7) % 7;
  return addDays(date, -back);
}

/** Instant at which reservations for `date` become possible. */
export function bookingOpensAt(date: LocalDate, s: BookingCalendarSettings): number {
  const weekStart = bookingWeekStart(date, s);
  const override = s.openingOverrides[weekStart];
  if (override) return muToInstant(override.date, override.time);
  let lead = (s.weekStartWeekday - s.openWeekday + 7) % 7;
  if (lead === 0) lead = 7;
  return muToInstant(addDays(weekStart, -lead), s.openTime);
}

export type BookabilityReason = "ok" | "closed_date" | "not_open_yet" | "past_cutoff";

/** Whether a date can be booked right now (table-level cut-off checked separately). */
export function dateBookability(
  date: LocalDate,
  nowMs: number,
  s: BookingCalendarSettings,
  cutoffMs: number,
): BookabilityReason {
  if (s.closedDates.includes(date)) return "closed_date";
  if (nowMs < bookingOpensAt(date, s)) return "not_open_yet";
  if (nowMs >= cutoffMs) return "past_cutoff";
  return "ok";
}

/** Dates currently open for booking, from today up to the end of the latest opened week. */
export function openBookingDates(today: LocalDate, nowMs: number, s: BookingCalendarSettings): LocalDate[] {
  const out: LocalDate[] = [];
  for (let i = 0; i < 21; i++) {
    const d = addDays(today, i);
    if (nowMs >= bookingOpensAt(d, s) && !s.closedDates.includes(d)) out.push(d);
  }
  return out;
}
