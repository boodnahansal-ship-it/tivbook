export type ListType = "new_player" | "movement";
export type WaitingStatus = "waiting" | "offered" | "accepted" | "declined" | "expired" | "skipped" | "cancelled" | "fulfilled";
export type PriorityPolicy = "fifo" | "existing_first" | "new_first" | "alternating" | "manual";

export interface WaitingEntry {
  id: string;
  playerId: string;
  listType: ListType;
  requestedAt: number;
  status: WaitingStatus;
  /** Manual position set by a floor supervisor (lower = earlier). Audit-logged by the backend. */
  priorityOverride?: number | null;
}

const byTime = (a: WaitingEntry, b: WaitingEntry) => a.requestedAt - b.requestedAt || a.id.localeCompare(b.id);

/** Entries still in the queue, ordered for display (alternating shown as interleaved). */
export function orderQueue(entries: readonly WaitingEntry[], policy: PriorityPolicy, lastServed?: ListType): WaitingEntry[] {
  const waiting = entries.filter((e) => e.status === "waiting");
  const moves = waiting.filter((e) => e.listType === "movement").sort(byTime);
  const news = waiting.filter((e) => e.listType === "new_player").sort(byTime);
  switch (policy) {
    case "fifo":
      return [...waiting].sort(byTime);
    case "existing_first":
      return [...moves, ...news];
    case "new_first":
      return [...news, ...moves];
    case "manual":
      return [...waiting].sort((a, b) => {
        const pa = a.priorityOverride ?? Number.POSITIVE_INFINITY;
        const pb = b.priorityOverride ?? Number.POSITIVE_INFINITY;
        return pa === pb ? byTime(a, b) : pa - pb;
      });
    case "alternating": {
      const out: WaitingEntry[] = [];
      let next: ListType = lastServed === "new_player" ? "movement" : "new_player";
      let i = 0, j = 0;
      while (i < news.length || j < moves.length) {
        if (next === "new_player" && i < news.length) out.push(news[i++]!);
        else if (next === "movement" && j < moves.length) out.push(moves[j++]!);
        else if (i < news.length) out.push(news[i++]!);
        else out.push(moves[j++]!);
        next = next === "new_player" ? "movement" : "new_player";
      }
      return out;
    }
  }
}

/**
 * Picks the next player to receive a place-available offer.
 * `isEligible` lets the backend exclude players who, for example, already hold an
 * active reservation that date or already have a pending offer.
 */
export function selectNext(
  entries: readonly WaitingEntry[],
  policy: PriorityPolicy,
  isEligible: (e: WaitingEntry) => boolean = () => true,
  lastServed?: ListType,
): WaitingEntry | null {
  return orderQueue(entries, policy, lastServed).find(isEligible) ?? null;
}

/** 1-based position of each waiting entry, for the player app ("You are #3"). */
export function queuePositions(entries: readonly WaitingEntry[], policy: PriorityPolicy, lastServed?: ListType): Map<string, number> {
  return new Map(orderQueue(entries, policy, lastServed).map((e, i) => [e.id, i + 1]));
}
