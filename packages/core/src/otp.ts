import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * One-time passcodes for WhatsApp phone verification (server only).
 * Codes are never stored in clear: only an HMAC with a server pepper.
 */
export const OTP_POLICY = {
  digits: 6,
  ttlMs: 5 * 60_000,
  maxAttempts: 5,
  /** Max codes sent to one phone in the rolling window. */
  maxSendsPerWindow: 3,
  sendWindowMs: 60 * 60_000,
  /** Minimum gap between two sends to the same phone. */
  resendCooldownMs: 30_000,
  /** Max codes requested from one IP per window (abuse protection). */
  maxSendsPerIpWindow: 10,
} as const;

export function generateOtp(digits: number = OTP_POLICY.digits): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, "0");
}

export function hashOtp(code: string, phoneE164: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`${phoneE164}:${code}`).digest("hex");
}

/** Normalises user input to E.164. Defaults to Mauritius (+230) for 7–8 digit local numbers. */
export function normalizePhone(input: string, defaultCountryCode = "230"): string | null {
  const raw = input.replace(/[\s().-]/g, "");
  let digits: string;
  if (raw.startsWith("+")) digits = raw.slice(1);
  else if (raw.startsWith("00")) digits = raw.slice(2);
  else if (/^\d{7,8}$/.test(raw)) digits = defaultCountryCode + raw;
  else digits = raw;
  if (!/^\d{8,15}$/.test(digits) || digits.startsWith("0")) return null;
  return `+${digits}`;
}

export interface OtpChallenge {
  codeHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
}

export interface SendHistory {
  /** Timestamps of recent sends to this phone. */
  phoneSends: number[];
  /** Timestamps of recent sends requested from this IP. */
  ipSends: number[];
}

export type SendDecision = { ok: true } | { ok: false; code: "COOLDOWN" | "TOO_MANY_FOR_PHONE" | "TOO_MANY_FROM_IP"; retryAfterMs: number };

export function canSendOtp(h: SendHistory, nowMs: number): SendDecision {
  const p = OTP_POLICY;
  const phone = h.phoneSends.filter((t) => nowMs - t < p.sendWindowMs).sort((a, b) => a - b);
  const ip = h.ipSends.filter((t) => nowMs - t < p.sendWindowMs).sort((a, b) => a - b);
  const last = phone.at(-1);
  if (last !== undefined && nowMs - last < p.resendCooldownMs) return { ok: false, code: "COOLDOWN", retryAfterMs: p.resendCooldownMs - (nowMs - last) };
  if (phone.length >= p.maxSendsPerWindow) return { ok: false, code: "TOO_MANY_FOR_PHONE", retryAfterMs: p.sendWindowMs - (nowMs - phone[0]!) };
  if (ip.length >= p.maxSendsPerIpWindow) return { ok: false, code: "TOO_MANY_FROM_IP", retryAfterMs: p.sendWindowMs - (nowMs - ip[0]!) };
  return { ok: true };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: "NO_CHALLENGE" | "EXPIRED" | "TOO_MANY_ATTEMPTS" | "WRONG_CODE" | "ALREADY_USED"; attemptsLeft: number };

/** Caller must persist `attempts + 1` (on failure) or `consumed = true` (on success). */
export function verifyOtp(ch: OtpChallenge | null, code: string, phoneE164: string, pepper: string, nowMs: number): VerifyResult {
  if (!ch) return { ok: false, code: "NO_CHALLENGE", attemptsLeft: 0 };
  const left = OTP_POLICY.maxAttempts - ch.attempts;
  if (ch.consumed) return { ok: false, code: "ALREADY_USED", attemptsLeft: 0 };
  if (nowMs >= ch.expiresAt) return { ok: false, code: "EXPIRED", attemptsLeft: 0 };
  if (left <= 0) return { ok: false, code: "TOO_MANY_ATTEMPTS", attemptsLeft: 0 };
  const clean = code.replace(/\D/g, "");
  const a = Buffer.from(hashOtp(clean, phoneE164, pepper));
  const b = Buffer.from(ch.codeHash);
  if (clean.length !== OTP_POLICY.digits || a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, code: "WRONG_CODE", attemptsLeft: left - 1 };
  return { ok: true };
}
