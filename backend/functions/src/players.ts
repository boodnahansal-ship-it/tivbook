import { FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { createHash, randomUUID } from "node:crypto";
import {
  ageOn, buildSearchTokens, formatPlayerId, instantToMuDate, isValidLegalName, MAX_ID_IMAGE_BYTES, missingImages,
  normalizePhone, normalizePlayerIdQuery, sniffImageType, type IdImageKind,
} from "@tivbook/core";
import { assertStaffDevice, audit, caller, db, getSettings, REGION, requireRole, STAFF, str, type Caller } from "./lib.js";

const ID_DOC_TYPES = ["national_id", "passport"] as const;
type IdDocType = (typeof ID_DOC_TYPES)[number];
const IMAGE_KINDS: IdImageKind[] = ["id_front", "id_back", "passport"];
const VIEW_ID_ROLES = STAFF.cashier; // super_admin, manager, cashier
const KYC_ROLES = STAFF.cashier;

interface EligibilitySettings { minimumAge: number }
const DEFAULT_ELIGIBILITY: EligibilitySettings = { minimumAge: 18 };

const claims = (req: { auth?: { token: unknown } }) => (req.auth?.token ?? {}) as Record<string, unknown>;

/* ───────────── Registration ───────────── */

/**
 * Creates a player and allocates the next permanent sequential ID in one transaction.
 * Self-registration: the phone must be the one verified by WhatsApp OTP.
 * Staff registration (front desk / cashier): approved device required.
 */
export const registerPlayer = onCall({ region: REGION }, async (req) => {
  const c = caller(req);
  const d = (req.data ?? {}) as Record<string, unknown>;
  const isStaff = STAFF.registration.includes(c.role);
  if (isStaff) await assertStaffDevice(c);
  else if (c.role !== "player" || claims(req).phoneVerified !== true) throw new HttpsError("permission-denied", "Verify your phone number first.");
  if (c.role === "player" && c.playerId) throw new HttpsError("already-exists", "You are already registered.");

  const surname = str(d.surname, "Surname", 80).toUpperCase();
  const firstNames = str(d.firstNames, "First name(s)", 120);
  if (!isValidLegalName(surname) || !firstNames.split(/\s+/).every(isValidLegalName))
    throw new HttpsError("invalid-argument", "Names must be written exactly as on the ID or passport (letters only).");
  const phoneE164 = normalizePhone(str(d.phone, "Mobile number", 30));
  if (!phoneE164) throw new HttpsError("invalid-argument", "Invalid mobile number.");
  if (!isStaff && phoneE164 !== claims(req).phoneE164) throw new HttpsError("permission-denied", "Use the phone number you verified.");
  const idDocType = str(d.idDocType, "Identity document type", 20) as IdDocType;
  if (!ID_DOC_TYPES.includes(idDocType)) throw new HttpsError("invalid-argument", "Unknown document type.");
  const idDocNumber = str(d.idDocNumber, "Document number", 40).toUpperCase().replace(/\s/g, "");
  const dateOfBirth = str(d.dateOfBirth, "Date of birth", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) throw new HttpsError("invalid-argument", "Invalid date of birth.");
  const { minimumAge } = await getSettings("system_settings/eligibility", DEFAULT_ELIGIBILITY);
  if (ageOn(dateOfBirth, instantToMuDate(Date.now())) < minimumAge)
    throw new HttpsError("failed-precondition", `Players must be at least ${minimumAge} years old.`);
  if (d.acceptedTerms !== true) throw new HttpsError("invalid-argument", "Terms and privacy policy must be accepted.");

  const idHash = createHash("sha256").update(`${idDocType}:${idDocNumber}`).digest("hex");
  const counterRef = db.doc("counters/playerId");

  const playerId = await db.runTransaction(async (tx) => {
    const [counter, dupPhone, dupId] = await Promise.all([
      tx.get(counterRef),
      tx.get(db.collection("players").where("phoneE164", "==", phoneE164).limit(1)),
      tx.get(db.collection("players").where("idDocNumberHash", "==", idHash).limit(1)),
    ]);
    if (!dupPhone.empty) throw new HttpsError("already-exists", "This phone number is already registered.");
    if (!dupId.empty) throw new HttpsError("already-exists", "This identity document is already registered.");
    const seq = (counter.get("next") as number | undefined) ?? 1;
    const id = formatPlayerId(seq);
    tx.set(counterRef, { next: seq + 1 }, { merge: true });
    tx.create(db.collection("players").doc(id), {
      playerId: id,
      surname,
      firstNames,
      phoneE164,
      phoneVerifiedAt: isStaff ? null : FieldValue.serverTimestamp(),
      address: String(d.address ?? "").slice(0, 300),
      countryOfResidence: String(d.countryOfResidence ?? "").slice(0, 60),
      nationality: String(d.nationality ?? "").slice(0, 60),
      dateOfBirth,
      idDocType,
      idDocNumberHash: idHash,
      idImages: [],
      status: "active",
      kycStatus: "unverified",
      language: d.language === "fr" ? "fr" : "en",
      searchTokens: buildSearchTokens({ surname, firstNames, phoneE164 }),
      authUid: isStaff ? null : c.uid,
      termsAcceptedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      createdBy: c.uid,
      source: isStaff ? c.role : "app",
    });
    tx.create(db.collection("players").doc(id).collection("private").doc("identity"), { idDocType, idDocNumber });
    audit(tx, { actor: c.uid, action: "player.register", entity: `players/${id}`, deviceId: c.deviceId });
    return id;
  });

  if (!isStaff) {
    const user = await getAuth().getUser(c.uid);
    await getAuth().setCustomUserClaims(c.uid, { ...(user.customClaims ?? {}), role: "player", playerId });
  }
  return { playerId };
});

/* ───────────── Identity documents ───────────── */

async function playerFor(c: Caller, requested: unknown, roles: typeof STAFF.registration): Promise<string> {
  if (c.role === "player") {
    if (!c.playerId) throw new HttpsError("failed-precondition", "Complete your registration first.");
    return c.playerId;
  }
  if (!roles.includes(c.role)) throw new HttpsError("permission-denied", "Not allowed.");
  await assertStaffDevice(c);
  return str(requested, "playerId", 12);
}

/** Upload (or replace) one ID image. Data is sent as base64; the app compresses photos first. */
export const uploadIdDocument = onCall({ region: REGION, memory: "512MiB" }, async (req) => {
  const c = caller(req);
  const d = (req.data ?? {}) as { playerId?: string; kind?: IdImageKind; base64?: string };
  const playerId = await playerFor(c, d.playerId, STAFF.registration);
  if (!d.kind || !IMAGE_KINDS.includes(d.kind)) throw new HttpsError("invalid-argument", "Unknown image kind.");
  const bytes = Buffer.from(String(d.base64 ?? ""), "base64");
  if (bytes.length < 1024) throw new HttpsError("invalid-argument", "Image missing or too small.");
  if (bytes.length > MAX_ID_IMAGE_BYTES) throw new HttpsError("invalid-argument", "Image too large (max 7 MB).");
  const type = sniffImageType(bytes);
  if (!type) throw new HttpsError("invalid-argument", "Only JPEG, PNG or HEIC photos are accepted.");

  const pRef = db.collection("players").doc(playerId);
  const p = await pRef.get();
  if (!p.exists) throw new HttpsError("not-found", "Player not found.");
  if (p.get("kycStatus") === "verified" && c.role === "player") throw new HttpsError("failed-precondition", "Your identity is already verified. Ask the cashier to update documents.");

  const docId = randomUUID();
  const path = `identity/${playerId}/${docId}.${type.split("/")[1]}`;
  await getStorage().bucket().file(path).save(bytes, { contentType: type, resumable: false, metadata: { cacheControl: "private, no-store" } });

  await db.runTransaction(async (tx) => {
    const prev = await tx.get(db.collection("identity_documents").where("playerId", "==", playerId).where("kind", "==", d.kind).where("replacedBy", "==", null));
    for (const old of prev.docs) tx.update(old.ref, { replacedBy: docId });
    tx.create(db.collection("identity_documents").doc(docId), {
      playerId, kind: d.kind, storagePath: path, contentType: type, sizeBytes: bytes.length,
      uploadedBy: c.uid, uploadedAt: FieldValue.serverTimestamp(), replacedBy: null,
    });
    tx.update(pRef, { idImages: FieldValue.arrayUnion(d.kind), ...(prev.size ? { kycStatus: p.get("kycStatus") === "rejected" ? "unverified" : p.get("kycStatus") } : {}) });
    audit(tx, { actor: c.uid, action: "identity.upload", entity: `identity_documents/${docId}`, deviceId: c.deviceId });
  });
  return { documentId: docId };
});

/** Staff view of an ID image (returned directly; every view is logged). */
export const getIdDocumentImage = onCall({ region: REGION, memory: "512MiB" }, async (req) => {
  const c = await requireRole(req, VIEW_ID_ROLES);
  const documentId = str((req.data as { documentId?: string })?.documentId, "documentId");
  const doc = await db.collection("identity_documents").doc(documentId).get();
  if (!doc.exists) throw new HttpsError("not-found", "Document not found.");
  const [buf] = await getStorage().bucket().file(doc.get("storagePath")).download();
  await db.collection("audit_logs").add({ actor: c.uid, action: "identity.view", entity: doc.ref.path, deviceId: c.deviceId, at: FieldValue.serverTimestamp() });
  return { contentType: doc.get("contentType"), base64: buf.toString("base64"), kind: doc.get("kind") };
});

/** Cashier/manager confirms (or rejects) the player's identity after seeing the original document. */
export const setKycStatus = onCall({ region: REGION }, async (req) => {
  const c = await requireRole(req, KYC_ROLES);
  const d = (req.data ?? {}) as { playerId?: string; status?: string; reason?: string; idDocNumber?: string };
  const playerId = str(d.playerId, "playerId", 12);
  if (d.status !== "verified" && d.status !== "rejected") throw new HttpsError("invalid-argument", "status must be verified or rejected.");
  const { minimumAge } = await getSettings("system_settings/eligibility", DEFAULT_ELIGIBILITY);
  const pRef = db.collection("players").doc(playerId);
  await db.runTransaction(async (tx) => {
    const p = await tx.get(pRef);
    if (!p.exists) throw new HttpsError("not-found", "Player not found.");
    if (d.status === "verified") {
      const missing = missingImages(p.get("idDocType"), p.get("idImages") ?? []);
      if (missing.length) throw new HttpsError("failed-precondition", `Missing document photo(s): ${missing.join(", ")}.`);
      if (ageOn(p.get("dateOfBirth"), instantToMuDate(Date.now())) < minimumAge) throw new HttpsError("failed-precondition", "Player is under the minimum age.");
    } else if (!d.reason) throw new HttpsError("invalid-argument", "A reason is required to reject.");
    tx.update(pRef, {
      kycStatus: d.status, kycReason: d.reason ?? null, kycBy: c.uid, kycAt: FieldValue.serverTimestamp(),
    });
    tx.set(pRef.collection("private").doc("identity"), { verifiedBy: c.uid, verifiedAt: FieldValue.serverTimestamp(), status: d.status }, { merge: true });
    audit(tx, { actor: c.uid, action: `kyc.${d.status}`, entity: pRef.path, after: { reason: d.reason ?? null }, deviceId: c.deviceId });
  });
  return { ok: true };
});

/* ───────────── Search ───────────── */

/** Search by player ID, phone, name, or ID-document number. */
export const searchPlayers = onCall({ region: REGION }, async (req) => {
  const c = await requireRole(req, [...new Set([...STAFF.registration, ...STAFF.reservations, ...STAFF.floor])]);
  const q = str((req.data as { query?: string })?.query, "query", 60);
  const players = db.collection("players");
  const results = new Map<string, FirebaseFirestore.DocumentSnapshot>();

  const asId = normalizePlayerIdQuery(q);
  if (asId) {
    const s = await players.doc(asId).get();
    if (s.exists) results.set(s.id, s);
  }
  const phone = /^[+\d\s()-]{7,}$/.test(q) ? normalizePhone(q) : null;
  if (phone) (await players.where("phoneE164", "==", phone).limit(5).get()).docs.forEach((s) => results.set(s.id, s));
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 4 && !asId) (await players.where("searchTokens", "array-contains", `tel:${digits.slice(-8)}`).limit(10).get()).docs.forEach((s) => results.set(s.id, s));
  const word = q.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2).sort((a, b) => b.length - a.length)[0];
  if (word && !/^\d+$/.test(word)) (await players.where("searchTokens", "array-contains", word).limit(25).get()).docs.forEach((s) => results.set(s.id, s));
  if (/^[A-Z0-9]{5,}$/i.test(q.replace(/\s/g, "")) && STAFF.cashier.includes(c.role)) {
    for (const t of ID_DOC_TYPES) {
      const hsh = createHash("sha256").update(`${t}:${q.replace(/\s/g, "").toUpperCase()}`).digest("hex");
      (await players.where("idDocNumberHash", "==", hsh).limit(2).get()).docs.forEach((s) => results.set(s.id, s));
    }
  }
  return {
    players: [...results.values()].slice(0, 25).map((s) => ({
      playerId: s.id, surname: s.get("surname"), firstNames: s.get("firstNames"), phoneE164: s.get("phoneE164"),
      kycStatus: s.get("kycStatus"), status: s.get("status"),
    })),
  };
});
