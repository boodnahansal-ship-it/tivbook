import { timingSafeEqual } from "node:crypto";
import { defineSecret } from "firebase-functions/params";
import { FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { audit, caller, db, isStaffRole, REGION, requireRole, str, type Role } from "./lib.js";

const STAFF_ROLES: Role[] = ["super_admin", "manager", "tournament_director", "cashier", "floor_supervisor", "dealer", "front_desk"];

/** Managers may create every role except super_admin and manager. */
function canAssign(actor: Role, target: Role) {
  if (actor === "super_admin") return true;
  return actor === "manager" && !["super_admin", "manager"].includes(target);
}

export const createStaffUser = onCall({ region: REGION }, async (req) => {
  const c = await requireRole(req, ["super_admin", "manager"]);
  const d = (req.data ?? {}) as { email?: string; displayName?: string; role?: Role; temporaryPassword?: string };
  const email = str(d.email, "email", 120).toLowerCase();
  const displayName = str(d.displayName, "displayName", 80);
  const role = d.role as Role;
  if (!STAFF_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Unknown role.");
  if (!canAssign(c.role, role)) throw new HttpsError("permission-denied", "You cannot create this role.");
  const password = str(d.temporaryPassword, "temporaryPassword", 64);
  if (password.length < 10) throw new HttpsError("invalid-argument", "Temporary password must be at least 10 characters.");
  const user = await getAuth().createUser({ email, password, displayName });
  await getAuth().setCustomUserClaims(user.uid, { role });
  await db.collection("staff").doc(user.uid).set({
    email, displayName, role, active: true, mustChangePassword: true, createdBy: c.uid, createdAt: FieldValue.serverTimestamp(),
  });
  await db.collection("audit_logs").add({ actor: c.uid, action: "staff.create", entity: `staff/${user.uid}`, after: { role }, at: FieldValue.serverTimestamp() });
  return { uid: user.uid };
});

export const updateStaffUser = onCall({ region: REGION }, async (req) => {
  const c = await requireRole(req, ["super_admin", "manager"]);
  const d = (req.data ?? {}) as { uid?: string; role?: Role; active?: boolean };
  const uid = str(d.uid, "uid", 128);
  if (uid === c.uid) throw new HttpsError("failed-precondition", "You cannot change your own account.");
  const ref = db.collection("staff").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Staff member not found.");
  if (!canAssign(c.role, snap.get("role"))) throw new HttpsError("permission-denied", "Not allowed for this account.");
  const update: Record<string, unknown> = {};
  if (d.role) {
    if (!STAFF_ROLES.includes(d.role) || !canAssign(c.role, d.role)) throw new HttpsError("permission-denied", "You cannot assign this role.");
    update.role = d.role;
    await getAuth().setCustomUserClaims(uid, { role: d.role });
  }
  if (typeof d.active === "boolean") {
    update.active = d.active;
    await getAuth().updateUser(uid, { disabled: !d.active });
    if (!d.active) await getAuth().revokeRefreshTokens(uid);
  }
  await ref.update(update);
  await db.collection("audit_logs").add({ actor: c.uid, action: "staff.update", entity: ref.path, before: snap.data(), after: update, at: FieldValue.serverTimestamp() });
  return { ok: true };
});

/**
 * Called by the staff software the first time it is used on a PC/phone.
 * The device then waits for approval. A Super Administrator's own device is approved immediately.
 */
export const requestDeviceApproval = onCall({ region: REGION }, async (req) => {
  const c = caller(req);
  if (!isStaffRole(c.role)) throw new HttpsError("permission-denied", "Staff only.");
  const d = (req.data ?? {}) as { deviceId?: string; name?: string; platform?: string };
  const deviceId = str(d.deviceId, "deviceId", 64);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) throw new HttpsError("invalid-argument", "Invalid device id.");
  const ref = db.collection("staff_devices").doc(deviceId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return { status: snap.get("status") as string };
    const status = c.role === "super_admin" ? "approved" : "pending";
    tx.create(ref, {
      name: String(d.name ?? "Unnamed device").slice(0, 60), platform: String(d.platform ?? "").slice(0, 40),
      status, requestedBy: c.uid, requestedAt: FieldValue.serverTimestamp(),
      ...(status === "approved" ? { approvedBy: c.uid, approvedAt: FieldValue.serverTimestamp() } : {}),
    });
    audit(tx, { actor: c.uid, action: `device.request.${status}`, entity: ref.path });
    return { status };
  });
});

export const setDeviceStatus = onCall({ region: REGION }, async (req) => {
  const c = await requireRole(req, ["super_admin", "manager"]);
  const d = (req.data ?? {}) as { targetDeviceId?: string; status?: string; name?: string };
  const id = str(d.targetDeviceId, "targetDeviceId", 64);
  if (d.status !== "approved" && d.status !== "revoked") throw new HttpsError("invalid-argument", "status must be approved or revoked.");
  if (id === c.deviceId && d.status === "revoked") throw new HttpsError("failed-precondition", "You cannot revoke the device you are using.");
  const ref = db.collection("staff_devices").doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Device not found.");
    tx.update(ref, { status: d.status, ...(d.name ? { name: d.name.slice(0, 60) } : {}), [`${d.status}By`]: c.uid, [`${d.status}At`]: FieldValue.serverTimestamp() });
    audit(tx, { actor: c.uid, action: `device.${d.status}`, entity: ref.path, deviceId: c.deviceId });
  });
  return { ok: true };
});

/** Clears the "must change password" flag after the staff member set their own password. */
export const passwordChanged = onCall({ region: REGION }, async (req) => {
  const c = caller(req);
  if (!isStaffRole(c.role)) throw new HttpsError("permission-denied", "Staff only.");
  // The password itself is changed with Firebase Auth `updatePassword` in the staff software.
  await db.collection("staff").doc(c.uid).update({ mustChangePassword: false, passwordChangedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/**
 * One-time creation of the first Super Administrator, used by the setup script.
 * Works only while there is no staff account at all, and only with the setup code.
 */
export const SETUP_CODE = defineSecret("SETUP_CODE");
export const bootstrapSuperAdmin = onCall({ region: REGION, secrets: [SETUP_CODE] }, async (req) => {
  const d = (req.data ?? {}) as { setupCode?: string; email?: string; password?: string; displayName?: string };
  const expected = SETUP_CODE.value();
  const given = String(d.setupCode ?? "");
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected)))
    throw new HttpsError("permission-denied", "Invalid setup code.");
  const email = str(d.email, "email", 120).toLowerCase();
  const password = str(d.password, "password", 128);
  if (password.length < 10) throw new HttpsError("invalid-argument", "Password must be at least 10 characters.");
  const lock = db.doc("counters/bootstrap");
  const existing = await db.collection("staff").limit(1).get();
  if (!existing.empty || (await lock.get()).exists) throw new HttpsError("failed-precondition", "Setup already completed.");
  await lock.create({ at: FieldValue.serverTimestamp() }); // fails if two calls race
  const user = await getAuth().createUser({ email, password, displayName: d.displayName ?? "Super Administrator" });
  await getAuth().setCustomUserClaims(user.uid, { role: "super_admin" });
  await db.collection("staff").doc(user.uid).set({
    email, displayName: d.displayName ?? "Super Administrator", role: "super_admin", active: true, mustChangePassword: false,
    createdBy: "setup", createdAt: FieldValue.serverTimestamp(),
  });
  return { uid: user.uid };
});
