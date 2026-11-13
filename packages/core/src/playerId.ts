/**
 * Permanent sequential player IDs: 001, 002 … 999, 1000, 1001 …
 * The sequence number is allocated by the backend in a transaction on `counters/playerId`.
 */
export function formatPlayerId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`Player sequence must be a positive integer, got ${sequence}`);
  }
  return String(sequence).padStart(3, "0");
}

export function parsePlayerId(id: string): number {
  const trimmed = id.trim();
  if (!/^\d{3,}$/.test(trimmed)) throw new Error(`Invalid player ID "${id}"`);
  const n = Number(trimmed);
  // "0012" is not a canonical ID — only numbers below 100 / 10 carry leading zeros.
  if (formatPlayerId(n) !== trimmed) throw new Error(`Non-canonical player ID "${id}"`);
  return n;
}

/** Lenient search input: "7", "07", "007" all find player 007. */
export function normalizePlayerIdQuery(query: string): string | null {
  const t = query.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && Number.isSafeInteger(n) ? formatPlayerId(n) : null;
}

/** Tokens for name/phone prefix search (stored on the player doc as `searchTokens`). */
export function buildSearchTokens(p: { surname: string; firstNames: string; phoneE164: string }): string[] {
  const words = `${p.surname} ${p.firstNames}`
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tokens = new Set<string>();
  for (const w of words) for (let i = 2; i <= w.length; i++) tokens.add(w.slice(0, i));
  const digits = p.phoneE164.replace(/\D/g, "");
  if (digits.length >= 4) tokens.add(`tel:${digits.slice(-8)}`);
  return [...tokens];
}
