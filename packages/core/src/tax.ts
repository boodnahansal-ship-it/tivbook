import { assertCents, percentOf, type Cents } from "./money.js";

export interface TaxRule {
  id: string;
  category: "tournament_prize" | string;
  /** 10% = 1000 basis points */
  rateBp: number;
  /** Tax applies when gross ≥ threshold. */
  thresholdCents: Cents;
  /** whole_amount: tax on the full prize; excess_only: tax only on the part above `exemptCents`. */
  method: "whole_amount" | "excess_only";
  /** For excess_only: tax-free portion (defaults to thresholdCents). */
  exemptCents?: Cents;
  effectiveFrom: number;
  effectiveTo?: number | null;
}

/**
 * DEFAULT configuration only, from current Ti Vegas practice: 10% on the whole
 * prize from Rs 100,001. Must be confirmed with compliance before go-live; the live
 * values live in the `tax_rules` collection and are editable.
 */
export const DEFAULT_PRIZE_TAX_RULE: TaxRule = {
  id: "default-prize-2026",
  category: "tournament_prize",
  rateBp: 1000,
  thresholdCents: 100_001_00,
  method: "whole_amount",
  effectiveFrom: 0,
};

export function activeRule(rules: readonly TaxRule[], category: string, atMs: number): TaxRule | null {
  const candidates = rules
    .filter((r) => r.category === category && r.effectiveFrom <= atMs && (r.effectiveTo == null || atMs < r.effectiveTo))
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom);
  return candidates[0] ?? null;
}

export interface TaxCalc { grossCents: Cents; taxCents: Cents; netCents: Cents; ruleId: string | null; override?: { taxCents: Cents; authorizedBy: string; reason: string } }

export function calculatePrizeTax(
  grossCents: Cents,
  rule: TaxRule | null,
  override?: { taxCents: Cents; authorizedBy: string; reason: string },
): TaxCalc {
  assertCents(grossCents, "gross");
  if (grossCents < 0) throw new Error("Gross prize cannot be negative.");
  if (override) {
    if (!override.authorizedBy || !override.reason) throw new Error("Tax override needs an authorizer and a reason.");
    assertCents(override.taxCents);
    if (override.taxCents < 0 || override.taxCents > grossCents) throw new Error("Override tax out of range.");
    return { grossCents, taxCents: override.taxCents, netCents: grossCents - override.taxCents, ruleId: rule?.id ?? null, override };
  }
  if (!rule || grossCents < rule.thresholdCents) return { grossCents, taxCents: 0, netCents: grossCents, ruleId: rule?.id ?? null };
  const base = rule.method === "whole_amount" ? grossCents : grossCents - (rule.exemptCents ?? rule.thresholdCents);
  const taxCents = percentOf(base, rule.rateBp);
  return { grossCents, taxCents, netCents: grossCents - taxCents, ruleId: rule.id };
}
