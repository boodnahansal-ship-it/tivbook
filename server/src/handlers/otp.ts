import { createHash } from "node:crypto";
import { canSendOtp, generateOtp, hashOtp, normalizePhone, OTP_POLICY, verifyOtp } from "@tivbook/core";
import { STAFF, type AppMetadata, type Handler } from "../context.js";
import { ApiError, audit, fail, randomSecret, requireRole } from "../util.js";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);
/** Each verified phone has a hidden login: an internal e-mail plus a fresh one-time password. */
export const playerLoginEmail = (phoneE164: string) => `p${h(phoneE164).slice(0, 24)}@players.tivbook.app`;

/**
 * Step 1 — create a code. It is sent by WhatsApp when WhatsApp is set up;
 * otherwise ("desk" mode) the cashier / front desk reads it to the player in person.
 * No sign-in needed.
 */
export const requestOtp: Handler = async (ctx, data) => {
  const phone = normalizePhone(String(data.phone ?? ""));
  if (!phone) fail("INVALID_PHONE", "Enter a valid mobile number with country code.");
  const now = ctx.now();
  const code = generateOtp();
  const viaWhatsApp = await ctx.services.whatsapp.isConfigured().catch(() => false);
  const delivery = viaWhatsApp ? "whatsapp" : "desk";
  const keep = (a: number[]) => [...a.filter((t) => now - t < OTP_POLICY.sendWindowMs), now];

  await ctx.sql.begin(async (tx) => {
    const [p] = await tx`select sends from otp_challenges where phone_hash = ${h(phone!)} for update`;
    const [i] = await tx`select sends from otp_ip where ip_hash = ${h(ctx.ip)} for update`;
    const phoneSends = ((p?.sends as string[]) ?? []).map(Number);
    const ipSends = ((i?.sends as string[]) ?? []).map(Number);
    const can = canSendOtp({ phoneSends, ipSends }, now);
    if (!can.ok) {
      throw new ApiError(can.code, can.code === "COOLDOWN" ? "Please wait a moment before requesting a new code." : "Too many codes requested. Please try again later.", 429, {
        retryAfterSec: Math.ceil(can.retryAfterMs / 1000),
      });
    }
    // Desk codes stay valid a little longer: the player has to walk to the desk.
    const ttl = delivery === "desk" ? DESK_TTL_MS : OTP_POLICY.ttlMs;
    await tx`insert into otp_challenges (phone_hash, code_hash, created_at, expires_at, attempts, consumed, sends, delivery, desk_phone, desk_code)
      values (${h(phone!)}, ${hashOtp(code, phone!, ctx.env.OTP_PEPPER)}, ${now}, ${now + ttl}, 0, false, ${keep(phoneSends)},
              ${delivery}, ${delivery === "desk" ? phone! : null}, ${delivery === "desk" ? code : null})
      on conflict (phone_hash) do update set code_hash = excluded.code_hash, created_at = excluded.created_at,
        expires_at = excluded.expires_at, attempts = 0, consumed = false, sends = excluded.sends,
        delivery = excluded.delivery, desk_phone = excluded.desk_phone, desk_code = excluded.desk_code`;
    await tx`insert into otp_ip (ip_hash, sends) values (${h(ctx.ip)}, ${keep(ipSends)})
      on conflict (ip_hash) do update set sends = excluded.sends`;
  });

  if (delivery === "desk") return { phone, delivery, expiresInSec: DESK_TTL_MS / 1000, digits: OTP_POLICY.digits };
  try {
    await ctx.services.whatsapp.sendOtp(phone!, code);
  } catch {
    // WhatsApp failed: the same code becomes available at the desk instead.
    await ctx.sql`update otp_challenges set delivery = 'desk', desk_phone = ${phone!}, desk_code = ${code}, expires_at = ${now + DESK_TTL_MS}
      where phone_hash = ${h(phone!)}`;
    return { phone, delivery: "desk", whatsappFailed: true, expiresInSec: DESK_TTL_MS / 1000, digits: OTP_POLICY.digits };
  }
  return { phone, delivery, expiresInSec: OTP_POLICY.ttlMs / 1000, digits: OTP_POLICY.digits };
};

export const DESK_TTL_MS = 15 * 60_000;

/** Cashier / front desk: sign-in codes waiting for players at the desk (newest first). */
export const listDeskCodes: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.registration);
  const q = String(d.query ?? "").replace(/\D/g, "");
  const rows = await ctx.sql`
    select o.desk_phone, o.desk_code, o.expires_at, o.attempts, p.player_id, p.surname, p.first_names
    from otp_challenges o left join players p on p.phone_e164 = o.desk_phone
    where o.delivery = 'desk' and not o.consumed and o.expires_at > ${ctx.now()} and o.desk_code is not null
      and (${q} = '' or o.desk_phone like ${"%" + q + "%"})
    order by o.created_at desc limit 30`;
  await audit(ctx.sql, { actor: c.uid, action: "otp.desk_view", entity: "otp_challenges", after: { count: rows.length }, deviceId: c.deviceId });
  return {
    codes: rows.map((r) => ({
      phone: r.desk_phone, code: r.desk_code, expiresAt: Number(r.expires_at), attemptsLeft: OTP_POLICY.maxAttempts - Number(r.attempts),
      player: r.player_id ? { id: r.player_id, name: `${r.surname} ${r.first_names}` } : null,
    })),
  };
};

const MESSAGES = {
  WRONG_CODE: (n: number) => `Incorrect code. ${n} attempt(s) left.`,
  EXPIRED: () => "This code has expired. Request a new one.",
  TOO_MANY_ATTEMPTS: () => "Too many attempts. Request a new code.",
  ALREADY_USED: () => "This code was already used. Request a new one.",
  NO_CHALLENGE: () => "Request a code first.",
};

/**
 * Step 2 — check the code, then return a one-time login for the player app.
 * A phone already registered at the front desk is linked to that player ID.
 */
export const verifyOtpCode: Handler = async (ctx, data) => {
  const phone = normalizePhone(String(data.phone ?? ""));
  if (!phone) fail("INVALID_PHONE", "Invalid phone number.");
  const result = await ctx.sql.begin(async (tx) => {
    const [row] = await tx`select * from otp_challenges where phone_hash = ${h(phone!)} for update`;
    const ch = row
      ? { codeHash: row.code_hash as string, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at), attempts: row.attempts as number, consumed: row.consumed as boolean }
      : null;
    const r = verifyOtp(ch, String(data.code ?? ""), phone!, ctx.env.OTP_PEPPER, ctx.now());
    if (!r.ok) {
      if (r.code === "WRONG_CODE") await tx`update otp_challenges set attempts = attempts + 1 where phone_hash = ${h(phone!)}`;
      return r;
    }
    await tx`update otp_challenges set consumed = true, desk_code = null where phone_hash = ${h(phone!)}`;
    return r;
  });
  if (!result.ok) throw new ApiError(result.code, MESSAGES[result.code](result.attemptsLeft), 400, { attemptsLeft: result.attemptsLeft });

  const [player] = await ctx.sql`select player_id from players where phone_e164 = ${phone!}`;
  const meta: AppMetadata = { role: "player", phone_e164: phone!, phone_verified: true, ...(player ? { player_id: player.player_id as string } : {}) };
  const email = playerLoginEmail(phone!);
  const password = randomSecret(24);
  const [link] = await ctx.sql`select user_id from player_auth where phone_e164 = ${phone!}`;
  let userId: string;
  if (link) {
    userId = link.user_id as string;
    await ctx.services.auth.updateUser(userId, { password, app_metadata: meta });
  } else {
    userId = (await ctx.services.auth.createUser({ email, password, app_metadata: meta })).id;
    await ctx.sql`insert into player_auth (phone_e164, user_id) values (${phone!}, ${userId}) on conflict (phone_e164) do nothing`;
  }
  if (player) await ctx.sql`update players set auth_user_id = ${userId}, phone_verified_at = coalesce(phone_verified_at, now()) where player_id = ${player.player_id}`;
  return { email, password, playerId: (player?.player_id as string | undefined) ?? null };
};
