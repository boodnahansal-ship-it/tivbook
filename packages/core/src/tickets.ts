import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Ticket tokens: "TV1.<id>.<sig>" — id is 16 random bytes (Crockford base32) and is
 * also the `tickets/{id}` document ID; sig is a truncated HMAC-SHA256 (80 bits) with a
 * server secret, so codes cannot be guessed or forged. No personal data in the code.
 * Runs on the server only (the secret never reaches a client).
 * The value fits in a Code 128 barcode (≈ 40 chars) and a small QR code.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, scanner-friendly

function base32(buf: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function sign(id: string, secret: string): string {
  return base32(createHmac("sha256", secret).update(`TV1.${id}`).digest().subarray(0, 10));
}

export function issueTicketToken(secret: string, random: Uint8Array = randomBytes(16)): { ticketId: string; token: string; tokenHash: string } {
  const ticketId = base32(random);
  const token = tokenForTicketId(ticketId, secret);
  return { ticketId, token, tokenHash: hashToken(token) };
}

/** Rebuilds the printable code for an existing ticket (used for authorized reprints). */
export function tokenForTicketId(ticketId: string, secret: string): string {
  if (secret.length < 32) throw new Error("Ticket secret must be at least 32 characters.");
  if (!/^[0-9A-Z]{26}$/.test(ticketId)) throw new Error("Invalid ticket id.");
  return `TV1.${ticketId}.${sign(ticketId, secret)}`;
}

/** What we store in the database: never the token itself. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token.trim().toUpperCase()).digest("hex");
}

export type TokenCheck = { ok: true; ticketId: string; tokenHash: string } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" };

/** Signature check before any database lookup (cheap rejection of forged codes). */
export function verifyTicketToken(raw: string, secret: string): TokenCheck {
  const token = raw.trim().toUpperCase();
  const m = /^TV1\.([0-9A-Z]{26})\.([0-9A-Z]{16})$/.exec(token);
  if (!m) return { ok: false, reason: "MALFORMED" };
  const expected = Buffer.from(sign(m[1]!, secret));
  const given = Buffer.from(m[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true, ticketId: m[1]!, tokenHash: hashToken(token) };
}

export type ScanOutcome =
  | { screen: "VALID"; chips: number }
  | { screen: "ALREADY VALIDATED"; at: number; by: string }
  | { screen: "INVALID OR UNPAID TICKET"; reason: string };

/** Floor decision once the backend has looked up the ticket. */
export function scanOutcome(input: {
  check: TokenCheck;
  ticket: null | { status: "valid" | "used" | "void"; paid: boolean; chips: number };
  delivery: null | { at: number; by: string };
}): ScanOutcome {
  if (!input.check.ok) return { screen: "INVALID OR UNPAID TICKET", reason: input.check.reason };
  if (!input.ticket) return { screen: "INVALID OR UNPAID TICKET", reason: "UNKNOWN_TICKET" };
  if (input.delivery) return { screen: "ALREADY VALIDATED", at: input.delivery.at, by: input.delivery.by };
  if (input.ticket.status === "void") return { screen: "INVALID OR UNPAID TICKET", reason: "VOID" };
  if (!input.ticket.paid) return { screen: "INVALID OR UNPAID TICKET", reason: "UNPAID" };
  return { screen: "VALID", chips: input.ticket.chips };
}
