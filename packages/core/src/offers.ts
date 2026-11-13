/**
 * Place-available offers. All times are server time (ms since epoch);
 * the app only displays a countdown to `expiresAt`.
 */
export type OfferStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled";

export interface Offer {
  id: string;
  waitingEntryId: string;
  playerId: string;
  tableDayId: string;
  createdAt: number;
  expiresAt: number;
  status: OfferStatus;
}

export const OFFER_DURATION_PRESETS_MIN = [1, 2, 3, 5, 10] as const;
export const DEFAULT_OFFER_MINUTES = 5;

export function offerDurationMs(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes < 0.5 || minutes > 60) {
    throw new Error("Offer duration must be between 30 seconds and 60 minutes.");
  }
  return Math.round(minutes * 60_000);
}

export function newOfferTimes(nowMs: number, minutes = DEFAULT_OFFER_MINUTES) {
  return { createdAt: nowMs, expiresAt: nowMs + offerDurationMs(minutes) };
}

export type OfferAction = "accept" | "decline";

export type OfferResponse =
  | { ok: true; status: "accepted" | "declined" }
  | { ok: false; code: "NOT_PENDING" | "EXPIRED" | "WRONG_PLAYER"; message: string };

/** Evaluate a player's response. Backend applies the result in the same transaction. */
export function respondToOffer(offer: Offer, playerId: string, action: OfferAction, nowMs: number): OfferResponse {
  if (offer.playerId !== playerId) return { ok: false, code: "WRONG_PLAYER", message: "This offer belongs to another player." };
  if (offer.status !== "pending") return { ok: false, code: "NOT_PENDING", message: `This offer is already ${offer.status}.` };
  if (nowMs >= offer.expiresAt) return { ok: false, code: "EXPIRED", message: "Sorry, this offer has expired." };
  return { ok: true, status: action === "accept" ? "accepted" : "declined" };
}

export function isOverdue(offer: Offer, nowMs: number): boolean {
  return offer.status === "pending" && nowMs >= offer.expiresAt;
}

/** Staff "Extend Deadline": extends from the later of now / current expiry. */
export function extendOffer(offer: Offer, extraMinutes: number, nowMs: number): number {
  if (offer.status !== "pending") throw new Error("Only pending offers can be extended.");
  return Math.max(nowMs, offer.expiresAt) + offerDurationMs(extraMinutes);
}

/** Text for the push notification. */
export function placeAvailableMessage(kind: "new_player" | "movement", tableName: string) {
  return {
    title: "TI VEGAS — PLACE AVAILABLE!",
    body:
      kind === "movement"
        ? "A place is available at your requested table. Accept to continue your movement request."
        : `A place is available at ${tableName}. Please confirm before your offer expires.`,
  };
}
