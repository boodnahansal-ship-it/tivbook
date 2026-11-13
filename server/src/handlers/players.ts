import { createHash, randomUUID } from "node:crypto";
import {
  ageOn, buildSearchTokens, formatPlayerId, instantToMuDate, isValidLegalName, MAX_ID_IMAGE_BYTES, missingImages,
  normalizePhone, normalizePlayerIdQuery, sniffImageType, type IdImageKind,
} from "@tivbook/core";
import { STAFF, type Handler } from "../context.js";
import { ApiError, assertStaffDevice, audit, denied, fail, getSetting, isoDate, isStaff, isUniqueViolation, requireRole, signedIn, str } from "../util.js";

const ID_DOC_TYPES = ["national_id", "passport"] as const;
type IdDocType = (typeof ID_DOC_TYPES)[number];
const IMAGE_KINDS: IdImageKind[] = ["id_front", "id_back", "passport"];
const DEFAULT_ELIGIBILITY = { minimumAge: 18 };
const idHash = (type: string, number: string) => createHash("sha256").update(`${type}:${number}`).digest("hex");

/* ───────── Registration ───────── */

/**
 * Creates a player with the next permanent sequential ID (never reused, no gaps).
 * Self-registration needs a WhatsApp-verified phone; staff need an approved device.
 */
export const registerPlayer: Handler = async (ctx, d) => {
  const c = signedIn(ctx);
  const staff = STAFF.registration.includes(c.role);
  if (staff) await assertStaffDevice(ctx.sql, c);
  else if (c.role !== "player" || !c.phoneVerified) denied("Verify your phone number first.");
  if (c.role === "player" && c.playerId) fail("ALREADY_REGISTERED", "You are already registered.");

  const surname = str(d.surname, "Surname", 80).toUpperCase();
  const firstNames = str(d.firstNames, "First name(s)", 120).replace(/\s+/g, " ");
  if (!isValidLegalName(surname) || !firstNames.split(" ").every(isValidLegalName))
    fail("INVALID_NAME", "Names must be written exactly as on the ID or passport (letters only).");
  const phone = normalizePhone(str(d.phone, "Mobile number", 30));
  if (!phone) fail("INVALID_PHONE", "Invalid mobile number.");
  if (!staff && phone !== c.phoneE164) denied("Use the phone number you verified.");
  const idDocType = str(d.idDocType, "Identity document type", 20) as IdDocType;
  if (!ID_DOC_TYPES.includes(idDocType)) fail("INVALID_ARGUMENT", "Unknown document type.");
  const idDocNumber = str(d.idDocNumber, "Document number", 40).toUpperCase().replace(/\s/g, "");
  const dob = str(d.dateOfBirth, "Date of birth", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) fail("INVALID_ARGUMENT", "Invalid date of birth.");
  const { minimumAge } = await getSetting(ctx.sql, "eligibility", DEFAULT_ELIGIBILITY);
  if (ageOn(dob, instantToMuDate(ctx.now())) < minimumAge) fail("UNDER_AGE", `Players must be at least ${minimumAge} years old.`);
  if (d.acceptedTerms !== true) fail("TERMS", "Terms and privacy policy must be accepted.");

  let playerId: string;
  try {
    playerId = await ctx.sql.begin(async (tx) => {
      const [counter] = await tx`select value from counters where name = 'player_seq' for update`;
      const seq = Number(counter!.value);
      const id = formatPlayerId(seq);
      await tx`update counters set value = ${seq + 1} where name = 'player_seq'`;
      await tx`insert into players (player_id, seq, surname, first_names, phone_e164, phone_verified_at, address, country_of_residence,
          nationality, date_of_birth, id_doc_type, id_doc_number_hash, language, search_tokens, auth_user_id, created_by, source)
        values (${id}, ${seq}, ${surname}, ${firstNames}, ${phone!}, ${staff ? null : new Date(ctx.now())},
          ${String(d.address ?? "").slice(0, 300)}, ${String(d.countryOfResidence ?? "").slice(0, 60)}, ${String(d.nationality ?? "").slice(0, 60)},
          ${dob}, ${idDocType}, ${idHash(idDocType, idDocNumber)}, ${d.language === "fr" ? "fr" : "en"},
          ${buildSearchTokens({ surname, firstNames, phoneE164: phone! })}, ${staff ? null : c.uid}, ${c.uid}, ${staff ? c.role : "app"})`;
      await tx`insert into player_identity (player_id, id_doc_type, id_doc_number) values (${id}, ${idDocType}, ${idDocNumber})`;
      await audit(tx, { actor: c.uid, action: "player.register", entity: `players/${id}`, deviceId: c.deviceId });
      return id;
    });
  } catch (e) {
    if (isUniqueViolation(e, "players_phone_e164_key")) fail("PHONE_EXISTS", "This phone number is already registered.");
    if (isUniqueViolation(e, "players_id_doc_number_hash_key")) fail("DOCUMENT_EXISTS", "This identity document is already registered.");
    throw e;
  }
  if (!staff) {
    await ctx.services.auth.updateUser(c.uid, { app_metadata: { role: "player", phone_e164: c.phoneE164, phone_verified: true, player_id: playerId } });
  }
  return { playerId };
};

/* ───────── Identity documents ───────── */

async function targetPlayer(ctx: Parameters<Handler>[0], requested: unknown): Promise<string> {
  const c = signedIn(ctx);
  if (c.role === "player") {
    if (!c.playerId) fail("NOT_REGISTERED", "Complete your registration first.");
    return c.playerId!;
  }
  if (!STAFF.registration.includes(c.role)) denied();
  await assertStaffDevice(ctx.sql, c);
  return str(requested, "playerId", 12);
}

/** Upload (or replace) one ID photo. The app shrinks photos (~200 KB) before sending. */
export const uploadIdDocument: Handler = async (ctx, d) => {
  const c = signedIn(ctx);
  const playerId = await targetPlayer(ctx, d.playerId);
  const kind = d.kind as IdImageKind;
  if (!IMAGE_KINDS.includes(kind)) fail("INVALID_ARGUMENT", "Unknown image kind.");
  const bytes = Uint8Array.from(Buffer.from(String(d.base64 ?? ""), "base64"));
  if (bytes.length < 1024) fail("INVALID_IMAGE", "Image missing or too small.");
  if (bytes.length > MAX_ID_IMAGE_BYTES) fail("IMAGE_TOO_LARGE", "Image too large (max 7 MB).");
  const type = sniffImageType(bytes);
  if (!type) fail("INVALID_IMAGE", "Only JPEG, PNG or HEIC photos are accepted.");

  const [p] = await ctx.sql`select kyc_status from players where player_id = ${playerId}`;
  if (!p) throw new ApiError("NOT_FOUND", "Player not found.", 404);
  if (p.kyc_status === "verified" && c.role === "player") fail("ALREADY_VERIFIED", "Your identity is already verified. Ask the cashier to update documents.");

  const id = randomUUID();
  const path = `${playerId}/${id}.${type!.split("/")[1]}`;
  await ctx.services.storage.upload(path, bytes, type!);
  await ctx.sql.begin(async (tx) => {
    await tx`update identity_documents set replaced_by = ${id} where player_id = ${playerId} and kind = ${kind} and replaced_by is null`;
    await tx`insert into identity_documents (id, player_id, kind, storage_path, content_type, size_bytes, uploaded_by)
      values (${id}, ${playerId}, ${kind}, ${path}, ${type!}, ${bytes.length}, ${c.uid})`;
    await tx`update players set id_images = array(select distinct unnest(id_images || ${[kind]}::text[])),
      kyc_status = case when kyc_status = 'rejected' then 'unverified' else kyc_status end where player_id = ${playerId}`;
    await audit(tx, { actor: c.uid, action: "identity.upload", entity: `identity_documents/${id}`, deviceId: c.deviceId });
  });
  return { documentId: id };
};

/** Staff view of an ID photo; every view is logged. */
export const getIdDocumentImage: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.cashier);
  const [doc] = await ctx.sql`select * from identity_documents where id = ${str(d.documentId, "documentId", 40)}`;
  if (!doc) throw new ApiError("NOT_FOUND", "Document not found.", 404);
  const bytes = await ctx.services.storage.download(doc.storage_path as string);
  await audit(ctx.sql, { actor: c.uid, action: "identity.view", entity: `identity_documents/${doc.id}`, deviceId: c.deviceId });
  return { contentType: doc.content_type, kind: doc.kind, base64: Buffer.from(bytes).toString("base64") };
};

/** Cashier confirms (or rejects) identity after seeing the ORIGINAL document. */
export const setKycStatus: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, STAFF.cashier);
  const playerId = str(d.playerId, "playerId", 12);
  const status = d.status;
  if (status !== "verified" && status !== "rejected") fail("INVALID_ARGUMENT", "status must be verified or rejected.");
  const reason = typeof d.reason === "string" && d.reason.trim() ? d.reason.trim().slice(0, 300) : null;
  const { minimumAge } = await getSetting(ctx.sql, "eligibility", DEFAULT_ELIGIBILITY);
  await ctx.sql.begin(async (tx) => {
    const [p] = await tx`select * from players where player_id = ${playerId} for update`;
    if (!p) throw new ApiError("NOT_FOUND", "Player not found.", 404);
    if (status === "verified") {
      const missing = missingImages(p.id_doc_type, p.id_images ?? []);
      if (missing.length) fail("MISSING_PHOTOS", `Missing document photo(s): ${missing.join(", ")}.`);
      if (ageOn(isoDate(p.date_of_birth), instantToMuDate(ctx.now())) < minimumAge) fail("UNDER_AGE", "Player is under the minimum age.");
    } else if (!reason) fail("REASON_REQUIRED", "A reason is required to reject.");
    await tx`update players set kyc_status = ${status as string}, kyc_reason = ${reason}, kyc_by = ${c.uid}, kyc_at = now() where player_id = ${playerId}`;
    await tx`update player_identity set verified_by = ${c.uid}, verified_at = now(), status = ${status as string} where player_id = ${playerId}`;
    await audit(tx, { actor: c.uid, action: `kyc.${status}`, entity: `players/${playerId}`, after: { reason }, deviceId: c.deviceId });
  });
  return { ok: true };
};

/* ───────── Search ───────── */

export const searchPlayers: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, [...new Set([...STAFF.registration, ...STAFF.reservations, ...STAFF.floor])]);
  const q = str(d.query, "query", 60);
  const asId = normalizePlayerIdQuery(q);
  const phone = /^[+\d\s()-]{7,}$/.test(q) ? normalizePhone(q) : null;
  const digits = q.replace(/\D/g, "");
  const word = q.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !/^\d+$/.test(w)).sort((a, b) => b.length - a.length)[0];
  const tokens: string[] = [];
  if (word) tokens.push(word);
  if (digits.length >= 4 && !asId) tokens.push(`tel:${digits.slice(-8)}`);
  const docHashes = /^[A-Z0-9]{5,}$/i.test(q.replace(/\s/g, "")) && STAFF.cashier.includes(c.role)
    ? ID_DOC_TYPES.map((t) => idHash(t, q.replace(/\s/g, "").toUpperCase()))
    : [];
  const rows = await ctx.sql`
    select player_id, surname, first_names, phone_e164, kyc_status, status from players
    where player_id = ${asId ?? ""} or phone_e164 = ${phone ?? ""} or search_tokens && ${tokens}::text[]
       or id_doc_number_hash = any(${docHashes}::text[])
    order by (player_id = ${asId ?? ""}) desc, surname, first_names limit 25`;
  return {
    players: rows.map((r) => ({ playerId: r.player_id, surname: r.surname, firstNames: r.first_names, phoneE164: r.phone_e164, kycStatus: r.kyc_status, status: r.status })),
  };
};

/** The player app registers its push token (for place-available alarms). */
export const registerPushToken: Handler = async (ctx, d) => {
  const c = signedIn(ctx);
  if (c.role !== "player" || !c.playerId) denied();
  const token = str(d.token, "token", 400);
  await ctx.sql`insert into player_devices (token, player_id, platform) values (${token}, ${c.playerId!}, ${String(d.platform ?? "").slice(0, 20)})
    on conflict (token) do update set player_id = excluded.player_id, platform = excluded.platform, updated_at = now()`;
  return { ok: true };
};

export { isStaff };
