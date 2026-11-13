import { assertCents, sum, type Cents } from "./money.js";

export type LedgerType =
  // cash games
  | "cash_buy_in" | "cash_additional_buy_in" | "cash_out" | "transfer_out" | "transfer_in"
  // tournaments
  | "tournament_buy_in" | "reentry" | "rebuy" | "addon" | "bonus" | "refund"
  | "prize_entitlement" | "prize_payout" | "tax_withholding"
  // corrections
  | "adjustment" | "reversal";

/** Effect on the cashier's drawer. */
export type CashDirection = "in" | "out" | "non_cash";

export const DIRECTION_OF: Record<LedgerType, CashDirection> = {
  cash_buy_in: "in",
  cash_additional_buy_in: "in",
  cash_out: "out",
  transfer_out: "non_cash",
  transfer_in: "non_cash",
  tournament_buy_in: "in",
  reentry: "in",
  rebuy: "in",
  addon: "in",
  bonus: "in",
  refund: "out",
  prize_entitlement: "non_cash",
  prize_payout: "out",
  tax_withholding: "non_cash",
  adjustment: "non_cash",
  reversal: "non_cash", // takes the opposite direction of the original — see cashEffect()
};

export interface LedgerTxn {
  id: string;
  playerId: string;
  type: LedgerType;
  amountCents: Cents; // always positive
  method: "cash" | "card" | "bank_transfer" | "cheque" | "none";
  cashierId: string;
  shiftId: string | null;
  createdAt: number;
  reversesTxnId?: string | null;
  reversedByTxnId?: string | null;
  /** For reversals: the original's direction, so the drawer effect can be undone. */
  originalDirection?: CashDirection | null;
  authRef?: string | null;
  notes?: string;
}

/** Signed effect on the physical cash drawer (+ in, − out, 0 none). */
export function cashEffect(t: LedgerTxn): Cents {
  if (t.method !== "cash") return 0;
  const dir = t.type === "reversal" ? flip(t.originalDirection ?? "non_cash") : DIRECTION_OF[t.type];
  return dir === "in" ? t.amountCents : dir === "out" ? -t.amountCents : 0;
}

const flip = (d: CashDirection): CashDirection => (d === "in" ? "out" : d === "out" ? "in" : "non_cash");

/** Builds a reversal record. The original is never edited except to link `reversedByTxnId`. */
export function buildReversal(original: LedgerTxn, by: { id: string; cashierId: string; shiftId: string | null; nowMs: number; authRef: string; reason: string }): LedgerTxn {
  if (original.type === "reversal") throw new Error("A reversal cannot itself be reversed; post a new transaction.");
  if (original.reversedByTxnId) throw new Error("Transaction already reversed.");
  if (!by.authRef || !by.reason) throw new Error("Reversal requires an authorization and a reason.");
  return {
    id: by.id,
    playerId: original.playerId,
    type: "reversal",
    amountCents: original.amountCents,
    method: original.method,
    cashierId: by.cashierId,
    shiftId: by.shiftId,
    createdAt: by.nowMs,
    reversesTxnId: original.id,
    originalDirection: DIRECTION_OF[original.type],
    authRef: by.authRef,
    notes: by.reason,
  };
}

export function validateTxn(t: LedgerTxn): void {
  assertCents(t.amountCents);
  if (t.amountCents <= 0) throw new Error("Ledger amounts are positive; direction comes from the type.");
}

/** Shift reconciliation: expected drawer = opening float + cash effects in the shift. */
export function reconcileShift(openingFloatCents: Cents, txns: readonly LedgerTxn[], declaredCents: Cents) {
  const expected = openingFloatCents + sum(txns.map(cashEffect));
  return { expectedCents: expected, declaredCents, varianceCents: declaredCents - expected };
}

/** Player spending summary for the cashier screen. */
export function spendingSummary(txns: readonly LedgerTxn[]) {
  const reversed = new Set(txns.filter((t) => t.type === "reversal" && t.reversesTxnId).map((t) => t.reversesTxnId!));
  const live = txns.filter((t) => t.type !== "reversal" && !reversed.has(t.id));
  const total = (...types: LedgerType[]) => sum(live.filter((t) => types.includes(t.type)).map((t) => t.amountCents));
  return {
    cashGameBuyInsCents: total("cash_buy_in", "cash_additional_buy_in"),
    cashGameCashOutsCents: total("cash_out"),
    tournamentBuyInsCents: total("tournament_buy_in"),
    reentriesCents: total("reentry"),
    rebuysCents: total("rebuy"),
    addonsCents: total("addon"),
    bonusesCents: total("bonus"),
    refundsCents: total("refund"),
    grossPrizesCents: total("prize_entitlement"),
    taxWithheldCents: total("tax_withholding"),
    netPrizesPaidCents: total("prize_payout"),
  };
}
