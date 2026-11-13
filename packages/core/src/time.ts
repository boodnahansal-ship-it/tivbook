/**
 * Mauritius time helpers. Indian/Mauritius is UTC+04:00 with no daylight saving,
 * so a fixed offset is exact. Dates are "YYYY-MM-DD" strings in local time.
 */
export const MU_OFFSET_MINUTES = 240;
const DAY_MS = 86_400_000;

export type LocalDate = string; // "2026-11-16"
export type LocalTime = string; // "10:00"

export function assertLocalDate(d: string): LocalDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new Error(`Invalid date "${d}" (expected YYYY-MM-DD)`);
  }
  return d;
}

/** Local Mauritius date+time → absolute instant (ms since epoch). */
export function muToInstant(date: LocalDate, time: LocalTime = "00:00"): number {
  assertLocalDate(date);
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) throw new Error(`Invalid time "${time}" (expected HH:MM)`);
  return Date.parse(`${date}T${m[1]}:${m[2]}:00Z`) - MU_OFFSET_MINUTES * 60_000;
}

/** Absolute instant → local Mauritius date. */
export function instantToMuDate(ms: number): LocalDate {
  return new Date(ms + MU_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${assertLocalDate(date)}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: LocalDate): number {
  return new Date(`${assertLocalDate(date)}T00:00:00Z`).getUTCDay();
}
