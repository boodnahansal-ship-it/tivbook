import { sum, type Cents } from "./money.js";

export type TournamentFormat =
  | "freezeout" | "reentry" | "rebuy" | "bounty" | "mystery_bounty" | "satellite" | "turbo" | "hyper_turbo" | "multi_day";

export interface PricedChips { priceCents: Cents; chips: number }

export interface TournamentConfig {
  id: string;
  formats: TournamentFormat[];
  buyInCents: Cents;
  startingChips: number;
  startAt: number;
  lateRegCloseAt: number;
  maxEntries?: number | null;
  reentry?: { maxPerPlayer: number } | null;
  rebuy?: (PricedChips & { maxPerPlayer: number; closesAt: number }) | null;
  addon?: (PricedChips & { opensAt: number; closesAt: number; maxPerPlayer: number }) | null;
  bonus?: (PricedChips & { availableWith: Array<"buy_in" | "reentry"> }) | null;
}

export type ChargeKind = "buy_in" | "reentry" | "rebuy" | "addon";

export interface PlayerTournamentState {
  /** Paid entries (first entry + re-entries) not refunded. */
  paidEntries: number;
  rebuys: number;
  addons: number;
  /** Has an entry that is currently active (not busted). Required for rebuy/add-on. */
  hasActiveEntry: boolean;
  /** Paid but chips not yet delivered — blocks a re-entry for the same player. */
  hasUndeliveredEntry: boolean;
}

export interface ChargeLine { kind: ChargeKind | "bonus"; priceCents: Cents; chips: number }

export type ChargeResult =
  | { ok: true; lines: ChargeLine[]; totalCents: Cents; totalChips: number }
  | { ok: false; code: string; message: string };

/**
 * Calculates what the cashier must collect and the chips the floor must issue.
 * Nothing is assumed about structure — every price/chip value comes from the tournament config.
 */
export function computeCharge(
  t: TournamentConfig,
  kind: ChargeKind,
  state: PlayerTournamentState,
  opts: { withBonus?: boolean; nowMs: number; totalEntriesSoFar: number },
): ChargeResult {
  const fail = (code: string, message: string): ChargeResult => ({ ok: false, code, message });
  const lines: ChargeLine[] = [];
  const { nowMs } = opts;

  if (kind === "buy_in" || kind === "reentry") {
    if (nowMs >= t.lateRegCloseAt) return fail("LATE_REG_CLOSED", "Late registration is closed.");
    if (t.maxEntries != null && opts.totalEntriesSoFar >= t.maxEntries) return fail("SOLD_OUT", "Maximum number of entries reached.");
    if (kind === "buy_in") {
      if (state.paidEntries > 0) return fail("ALREADY_ENTERED", "Player already has an entry. Use re-entry.");
    } else {
      if (!t.reentry) return fail("NO_REENTRY", "This tournament does not allow re-entry.");
      if (state.paidEntries === 0) return fail("NO_FIRST_ENTRY", "Player has no first entry yet.");
      if (state.hasActiveEntry || state.hasUndeliveredEntry)
        return fail("ENTRY_STILL_ACTIVE", "Player must be eliminated before re-entering.");
      if (state.paidEntries - 1 >= t.reentry.maxPerPlayer) return fail("REENTRY_LIMIT", "Re-entry limit reached.");
    }
    lines.push({ kind, priceCents: t.buyInCents, chips: t.startingChips });
    if (opts.withBonus) {
      if (!t.bonus || !t.bonus.availableWith.includes(kind)) return fail("NO_BONUS", "Bonus not available for this entry.");
      lines.push({ kind: "bonus", priceCents: t.bonus.priceCents, chips: t.bonus.chips });
    }
  } else if (kind === "rebuy") {
    if (!t.rebuy) return fail("NO_REBUY", "This tournament has no rebuys.");
    if (!state.hasActiveEntry) return fail("NOT_IN_PLAY", "Player has no active entry.");
    if (nowMs >= t.rebuy.closesAt) return fail("REBUY_CLOSED", "Rebuy period has ended.");
    if (state.rebuys >= t.rebuy.maxPerPlayer) return fail("REBUY_LIMIT", "Rebuy limit reached.");
    lines.push({ kind, priceCents: t.rebuy.priceCents, chips: t.rebuy.chips });
  } else {
    if (!t.addon) return fail("NO_ADDON", "This tournament has no add-on.");
    if (!state.hasActiveEntry) return fail("NOT_IN_PLAY", "Player has no active entry.");
    if (nowMs < t.addon.opensAt || nowMs >= t.addon.closesAt) return fail("ADDON_NOT_OPEN", "Add-on is not available now.");
    if (state.addons >= t.addon.maxPerPlayer) return fail("ADDON_LIMIT", "Add-on limit reached.");
    lines.push({ kind, priceCents: t.addon.priceCents, chips: t.addon.chips });
  }
  return {
    ok: true,
    lines,
    totalCents: sum(lines.map((l) => l.priceCents)),
    totalChips: lines.reduce((a, l) => a + l.chips, 0),
  };
}

export type EntryStatus = "preregistered" | "payment_pending" | "paid" | "awaiting_chips" | "entered" | "cancelled" | "refunded";

const ENTRY_TRANSITIONS: Record<EntryStatus, readonly EntryStatus[]> = {
  preregistered: ["payment_pending", "paid", "cancelled"],
  payment_pending: ["paid", "cancelled"],
  paid: ["awaiting_chips", "refunded"],
  awaiting_chips: ["entered", "refunded"],
  entered: [],
  cancelled: [],
  refunded: [],
};

export function canTransitionEntry(from: EntryStatus, to: EntryStatus): boolean {
  return ENTRY_TRANSITIONS[from].includes(to);
}

/** Server-driven countdown values for the app. */
export function countdown(targetMs: number, nowMs: number) {
  const ms = Math.max(0, targetMs - nowMs);
  const s = Math.floor(ms / 1000);
  return { done: ms === 0, days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}
