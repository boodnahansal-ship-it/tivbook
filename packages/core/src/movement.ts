import { assertCents, sum, type Cents } from "./money.js";

export type PlayerResult = "winning" | "losing" | "break_even";
export type Direction = "higher" | "equal" | "lower";
export type RuleOutcome = "allowed" | "approval" | "restricted";
export type MovementMatrix = Record<PlayerResult, Record<Direction, RuleOutcome>>;

export const DEFAULT_MOVEMENT_MATRIX: MovementMatrix = {
  winning: { higher: "allowed", equal: "allowed", lower: "restricted" },
  losing: { higher: "allowed", equal: "allowed", lower: "approval" },
  break_even: { higher: "allowed", equal: "allowed", lower: "approval" },
};

export interface SessionMoney {
  initialBuyInCents: Cents;
  additionalBuyInsCents: readonly Cents[];
  /** Value brought in from a previous table movement (not new cash). */
  transferInCents: Cents;
  currentChipValueCents: Cents;
}

export function totalBuyIn(s: SessionMoney): Cents {
  return sum([s.initialBuyInCents, ...s.additionalBuyInsCents, s.transferInCents]);
}

export function profitLoss(s: SessionMoney): Cents {
  return assertCents(s.currentChipValueCents) - totalBuyIn(s);
}

export function classify(s: SessionMoney): PlayerResult {
  const pl = profitLoss(s);
  return pl > 0 ? "winning" : pl < 0 ? "losing" : "break_even";
}

export interface TableLimits {
  minBuyInCents: Cents;
  maxBuyInCents: Cents;
}

export function direction(from: TableLimits, to: TableLimits): Direction {
  if (to.minBuyInCents > from.minBuyInCents) return "higher";
  if (to.minBuyInCents < from.minBuyInCents) return "lower";
  return "equal";
}

export type MovementDecision =
  | {
      outcome: "allowed" | "approval";
      classification: PlayerResult;
      direction: Direction;
      profitLossCents: Cents;
      transferCents: Cents;
    }
  | {
      outcome: "rejected";
      code: "RESTRICTED_BY_POLICY" | "BELOW_DESTINATION_MIN" | "ABOVE_DESTINATION_MAX" | "PARTIAL_TRANSFER" | "NO_CHIPS";
      message: string;
      classification: PlayerResult;
      direction: Direction;
      profitLossCents: Cents;
    };

/**
 * Evaluates a table movement. Full-value rule: the value moved must equal the
 * verified chip value. Chips are never removed automatically to fit a maximum.
 */
export function evaluateMovement(input: {
  session: SessionMoney;
  from: TableLimits;
  to: TableLimits;
  /** Value the floor intends to move. Must equal current chip value. */
  proposedTransferCents: Cents;
  matrix?: MovementMatrix;
}): MovementDecision {
  const matrix = input.matrix ?? DEFAULT_MOVEMENT_MATRIX;
  const classification = classify(input.session);
  const dir = direction(input.from, input.to);
  const pl = profitLoss(input.session);
  const base = { classification, direction: dir, profitLossCents: pl };
  const chips = input.session.currentChipValueCents;

  if (chips <= 0) return { outcome: "rejected", code: "NO_CHIPS", message: "Player has no chips to transfer.", ...base };
  if (assertCents(input.proposedTransferCents) !== chips)
    return {
      outcome: "rejected",
      code: "PARTIAL_TRANSFER",
      message: "The full chip value must be transferred. Partial cash-outs to move tables are not permitted.",
      ...base,
    };
  const rule = matrix[classification][dir];
  if (rule === "restricted")
    return {
      outcome: "rejected",
      code: "RESTRICTED_BY_POLICY",
      message: `Movement to a ${dir}-buy-in table is restricted for a ${classification.replace("_", "-")} player.`,
      ...base,
    };
  if (chips < input.to.minBuyInCents)
    return { outcome: "rejected", code: "BELOW_DESTINATION_MIN", message: "Chip value is below the destination table's minimum buy-in.", ...base };
  if (chips > input.to.maxBuyInCents)
    return { outcome: "rejected", code: "ABOVE_DESTINATION_MAX", message: "Chip value exceeds the destination table's maximum buy-in.", ...base };
  return { outcome: rule, transferCents: chips, ...base };
}

export type MovementStatus =
  | "requested"
  | "waiting"
  | "place_available"
  | "pending_financial_verification"
  | "pending_approval"
  | "approved"
  | "completed"
  | "rejected"
  | "cancelled";

const MOVE_TRANSITIONS: Record<MovementStatus, readonly MovementStatus[]> = {
  requested: ["waiting", "cancelled"],
  waiting: ["place_available", "cancelled"],
  place_available: ["pending_financial_verification", "waiting", "cancelled"],
  pending_financial_verification: ["pending_approval", "approved", "rejected", "cancelled"],
  pending_approval: ["approved", "rejected", "cancelled"],
  approved: ["completed", "cancelled"],
  completed: [],
  rejected: [],
  cancelled: [],
};

export function canTransitionMovement(from: MovementStatus, to: MovementStatus): boolean {
  return MOVE_TRANSITIONS[from].includes(to);
}
