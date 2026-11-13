import { assertCents, type Cents } from "./money.js";

/** Default daily cash payout cap (configurable in `payout_limits/current`). */
export const DEFAULT_DAILY_CASH_CAP_CENTS: Cents = 500_000_00;

/**
 * Splits a cash payout into daily instalments under the cap.
 * `alreadyPaidTodayCents` = cash already paid to this player today (all prizes).
 * Each instalment gets its own receipt.
 */
export function planCashInstalments(netCents: Cents, dailyCapCents: Cents, alreadyPaidTodayCents: Cents = 0): Cents[] {
  assertCents(netCents);
  assertCents(dailyCapCents);
  assertCents(alreadyPaidTodayCents);
  if (netCents <= 0) return [];
  if (dailyCapCents <= 0) throw new Error("Daily cap must be positive.");
  const out: Cents[] = [];
  let remaining = netCents;
  const today = Math.max(0, dailyCapCents - alreadyPaidTodayCents);
  if (today > 0) {
    const first = Math.min(today, remaining);
    out.push(first);
    remaining -= first;
  } else {
    out.push(0); // nothing can be paid today — first instalment is tomorrow
  }
  while (remaining > 0) {
    const part = Math.min(dailyCapCents, remaining);
    out.push(part);
    remaining -= part;
  }
  return out;
}

export type PayoutCheck = { ok: true; payableNowCents: Cents } | { ok: false; code: string; message: string };

/** Guards a single payout: no overpayment, cap respected, results approved, ID verified. */
export function checkPayout(input: {
  entitlementNetCents: Cents;
  alreadyPaidNetCents: Cents;
  requestedCents: Cents;
  method: "cash" | "bank_transfer" | "cheque";
  dailyCapCents: Cents;
  paidCashTodayCents: Cents;
  resultsApproved: boolean;
  identityVerified: boolean;
}): PayoutCheck {
  if (!input.resultsApproved) return { ok: false, code: "RESULTS_NOT_APPROVED", message: "Results must be approved before payout." };
  if (!input.identityVerified) return { ok: false, code: "ID_NOT_VERIFIED", message: "Verify the player's identity first." };
  const outstanding = input.entitlementNetCents - input.alreadyPaidNetCents;
  if (outstanding <= 0) return { ok: false, code: "ALREADY_PAID", message: "This prize has already been paid in full." };
  if (input.requestedCents <= 0 || input.requestedCents > outstanding)
    return { ok: false, code: "INVALID_AMOUNT", message: `Amount must be between Rs 0.01 and the outstanding balance.` };
  if (input.method === "cash" && input.paidCashTodayCents + input.requestedCents > input.dailyCapCents)
    return { ok: false, code: "DAILY_CASH_CAP", message: "This payment would exceed today's cash payout limit." };
  return { ok: true, payableNowCents: input.requestedCents };
}
