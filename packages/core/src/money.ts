/**
 * Money is always handled as an integer number of cents (Rs 1.00 = 100).
 * Never use floating point for amounts.
 */
export type Cents = number;

export class MoneyError extends Error {}

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of cents, got ${value}`);
  }
  return value;
}

/** Parse "1,250.50", "Rs 1250.5", "1250" → 125050 / 125050 / 125000. Rejects >2 decimals. */
export function parseRupees(input: string): Cents {
  const cleaned = input.replace(/rs\.?|mur|,|\s/gi, "");
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw new MoneyError(`Invalid amount: "${input}"`);
  const sign = m[1] ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  return assertCents(sign * (whole * 100 + frac));
}

/** 125050 → "Rs 1,250.50" */
export function formatRupees(cents: Cents, opts: { symbol?: boolean } = {}): string {
  assertCents(cents);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}${opts.symbol === false ? "" : "Rs "}${whole}.${frac}`;
}

export function sum(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total, "sum");
}

/**
 * Percentage expressed in basis points (10% = 1000 bp), rounded half-up to the cent.
 * Integer arithmetic only.
 */
export function percentOf(amount: Cents, basisPoints: number): Cents {
  assertCents(amount);
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
    throw new MoneyError("basisPoints must be a non-negative integer");
  }
  const sign = amount < 0 ? -1 : 1;
  const product = Math.abs(amount) * basisPoints;
  return assertCents(sign * Math.floor((product + 5000) / 10000));
}
