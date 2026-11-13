import { createHash } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { canSendOtp, generateOtp, hashOtp, normalizePhone, OTP_POLICY, verifyOtp, type OtpChallenge } from "@tivbook/core";
import { db, REGION } from "./lib.js";
import { sendWhatsAppOtp, WHATSAPP_TOKEN } from "./whatsapp.js";

export const OTP_PEPPER = defineSecret("OTP_PEPPER");

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);
export const uidForPhone = (phoneE164: string) => `p_${h(phoneE164).slice(0, 24)}`;

/** Step 1 — send a code by WhatsApp. No sign-in needed. */
export const requestOtp = onCall({ region: REGION, secrets: [OTP_PEPPER, WHATSAPP_TOKEN], enforceAppCheck: false }, async (req) => {
  const phone = normalizePhone(String((req.data as { phone?: string })?.phone ?? ""));
  if (!phone) throw new HttpsError("invalid-argument", "Enter a valid mobile number with country code.");
  const now = Date.now();
  const ip = req.rawRequest.ip ?? "unknown";
  const phoneRef = db.collection("otp_challenges").doc(h(phone));
  const ipRef = db.collection("otp_ip").doc(h(ip));
  const code = generateOtp();

  await db.runTransaction(async (tx) => {
    const [p, i] = await Promise.all([tx.get(phoneRef), tx.get(ipRef)]);
    const phoneSends: number[] = p.get("sends") ?? [];
    const ipSends: number[] = i.get("sends") ?? [];
    const can = canSendOtp({ phoneSends, ipSends }, now);
    if (!can.ok) {
      throw new HttpsError("resource-exhausted", can.code === "COOLDOWN" ? "Please wait a moment before requesting a new code." : "Too many codes requested. Please try again later.", {
        code: can.code, retryAfterSec: Math.ceil(can.retryAfterMs / 1000),
      });
    }
    const keep = (a: number[]) => [...a.filter((t) => now - t < OTP_POLICY.sendWindowMs), now];
    const challenge: OtpChallenge = { codeHash: hashOtp(code, phone, OTP_PEPPER.value()), createdAt: now, expiresAt: now + OTP_POLICY.ttlMs, attempts: 0, consumed: false };
    tx.set(phoneRef, { challenge, sends: keep(phoneSends) });
    tx.set(ipRef, { sends: keep(ipSends) });
  });

  try {
    await sendWhatsAppOtp(phone, code);
  } catch {
    await phoneRef.update({ "challenge.consumed": true });
    throw new HttpsError("unavailable", "We could not send the WhatsApp message. Check the number has WhatsApp and try again.");
  }
  return { phone, expiresInSec: OTP_POLICY.ttlMs / 1000, digits: OTP_POLICY.digits };
});

/**
 * Step 2 — check the code. Returns a sign-in token for the player app.
 * If a player with this phone already exists (e.g. registered at the front desk),
 * the account is linked to that player ID.
 */
export const verifyOtpCode = onCall({ region: REGION, secrets: [OTP_PEPPER] }, async (req) => {
  const d = (req.data ?? {}) as { phone?: string; code?: string };
  const phone = normalizePhone(String(d.phone ?? ""));
  if (!phone) throw new HttpsError("invalid-argument", "Invalid phone number.");
  const ref = db.collection("otp_challenges").doc(h(phone));

  const ok = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const ch = (snap.get("challenge") as OtpChallenge | undefined) ?? null;
    const r = verifyOtp(ch, String(d.code ?? ""), phone, OTP_PEPPER.value(), Date.now());
    if (!r.ok) {
      if (r.code === "WRONG_CODE") tx.update(ref, { "challenge.attempts": (ch?.attempts ?? 0) + 1 });
      return r;
    }
    tx.update(ref, { "challenge.consumed": true });
    return r;
  });
  if (!ok.ok) {
    const msg = {
      WRONG_CODE: `Incorrect code. ${ok.attemptsLeft} attempt(s) left.`,
      EXPIRED: "This code has expired. Request a new one.",
      TOO_MANY_ATTEMPTS: "Too many attempts. Request a new code.",
      ALREADY_USED: "This code was already used. Request a new one.",
      NO_CHALLENGE: "Request a code first.",
    }[ok.code];
    throw new HttpsError("failed-precondition", msg, { code: ok.code, attemptsLeft: ok.attemptsLeft });
  }

  const uid = uidForPhone(phone);
  const auth = getAuth();
  await auth.getUser(uid).catch(() => auth.createUser({ uid }));
  const existing = await db.collection("players").where("phoneE164", "==", phone).limit(1).get();
  const playerId = existing.empty ? undefined : existing.docs[0]!.id;
  if (playerId) {
    await existing.docs[0]!.ref.update({ authUid: uid, phoneVerifiedAt: new Date() });
  }
  await auth.setCustomUserClaims(uid, { role: "player", phoneVerified: true, phoneE164: phone, ...(playerId ? { playerId } : {}) });
  return { token: await auth.createCustomToken(uid), playerId: playerId ?? null };
});
