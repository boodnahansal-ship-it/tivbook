import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

initializeApp();
export const db = getFirestore();
export const REGION = "europe-west1";

export type Role =
  | "super_admin" | "manager" | "tournament_director" | "cashier" | "floor_supervisor" | "dealer" | "front_desk" | "player";

export const STAFF = {
  admin: ["super_admin", "manager"] as Role[],
  cashier: ["super_admin", "manager", "cashier"] as Role[],
  floor: ["super_admin", "manager", "tournament_director", "floor_supervisor", "dealer"] as Role[],
  floorSupervisor: ["super_admin", "manager", "floor_supervisor"] as Role[],
  registration: ["super_admin", "manager", "cashier", "front_desk"] as Role[],
  reservations: ["super_admin", "manager", "cashier", "floor_supervisor", "front_desk"] as Role[],
};

export interface Caller {
  uid: string;
  role: Role;
  playerId?: string;
  deviceId?: string;
}

/**
 * Identity of the caller. Role and playerId come from Firebase Auth custom claims
 * (set only by the server). Staff calls also carry the PC/phone's `deviceId`,
 * which must have been approved by an administrator.
 */
export function caller(req: CallableRequest<unknown>): Caller {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in.");
  const t = req.auth.token as Record<string, unknown>;
  const role = (t.role as Role | undefined) ?? "player";
  const deviceId = (req.data as { deviceId?: unknown } | null)?.deviceId;
  return { uid: req.auth.uid, role, playerId: t.playerId as string | undefined, deviceId: typeof deviceId === "string" ? deviceId : undefined };
}

export function isStaffRole(r: Role) {
  return r !== "player";
}

/** Throws unless the caller is staff on an approved device and active account. */
export async function assertStaffDevice(c: Caller): Promise<void> {
  if (!c.deviceId) throw new HttpsError("permission-denied", "This device is not authorized for staff use.", { code: "DEVICE_NOT_APPROVED" });
  const [dev, staff] = await Promise.all([db.collection("staff_devices").doc(c.deviceId).get(), db.collection("staff").doc(c.uid).get()]);
  if (!dev.exists || dev.get("status") !== "approved") throw new HttpsError("permission-denied", "This device is waiting for administrator approval.", { code: "DEVICE_NOT_APPROVED" });
  if (!staff.exists || staff.get("active") !== true) throw new HttpsError("permission-denied", "Your staff account is disabled.");
}

export async function requireRole(req: CallableRequest<unknown>, roles: Role[]): Promise<Caller> {
  const c = caller(req);
  if (!roles.includes(c.role)) throw new HttpsError("permission-denied", "Your account is not allowed to do this.");
  if (isStaffRole(c.role)) await assertStaffDevice(c);
  return c;
}

/** A player acting for themself, or staff (on an approved device) acting for a given player. */
export async function resolvePlayerId(c: Caller, requested: string | undefined, staffRoles: Role[]): Promise<string> {
  if (c.role === "player") {
    if (!c.playerId) throw new HttpsError("failed-precondition", "Complete your registration first.");
    if (requested && requested !== c.playerId) throw new HttpsError("permission-denied", "You can only act for your own account.");
    return c.playerId;
  }
  if (!staffRoles.includes(c.role)) throw new HttpsError("permission-denied", "Not allowed.");
  await assertStaffDevice(c);
  if (!requested) throw new HttpsError("invalid-argument", "playerId is required.");
  return requested;
}

export function fail(code: string, message: string): never {
  throw new HttpsError("failed-precondition", message, { code });
}

export function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpsError("invalid-argument", `${name} is required.`);
  return v.trim();
}

/** Idempotency inside a transaction: returns the stored result for a repeated key. */
export async function idemGet<T>(tx: Transaction, key: string): Promise<{ ref: DocumentReference; result: T | null }> {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw new HttpsError("invalid-argument", "Invalid idempotency key.");
  const ref = db.collection("idempotency").doc(key);
  const snap = await tx.get(ref);
  return { ref, result: snap.exists ? (snap.data()!.result as T) : null };
}

export function idemSet(tx: Transaction, ref: DocumentReference, by: string, result: unknown) {
  tx.create(ref, { result, by, createdAt: FieldValue.serverTimestamp() });
}

export function audit(tx: Transaction, entry: { actor: string; action: string; entity: string; authorizer?: string; before?: unknown; after?: unknown; deviceId?: string }) {
  tx.create(db.collection("audit_logs").doc(), { ...entry, at: FieldValue.serverTimestamp() });
}

export async function getSettings<T>(path: string, fallback: T): Promise<T> {
  const snap = await db.doc(path).get();
  return snap.exists ? ({ ...fallback, ...(snap.data() as Partial<T>) } as T) : fallback;
}

/** Push to all of a player's registered devices. Delivery is best-effort. */
export async function pushToPlayer(
  playerId: string,
  msg: { title: string; body: string; channel: "place_available" | "reminders"; data?: Record<string, string> },
) {
  const devices = await db.collection("players").doc(playerId).collection("devices").get();
  const tokens = devices.docs.map((d) => d.get("fcmToken") as string).filter(Boolean);
  if (!tokens.length) return { sent: 0, failed: 0 };
  const urgent = msg.channel === "place_available";
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body },
    data: { channel: msg.channel, ...(msg.data ?? {}) },
    android: {
      priority: "high",
      notification: { channelId: msg.channel, sound: urgent ? "tivbook_place_available" : "default", defaultVibrateTimings: true },
    },
    apns: {
      headers: { "apns-priority": "10" },
      payload: { aps: { sound: urgent ? "tivbook_place_available.caf" : "default", "interruption-level": urgent ? "time-sensitive" : "active" } },
    },
  });
  if (res.failureCount) logger.warn("push failures", { playerId, failed: res.failureCount });
  return { sent: res.successCount, failed: res.failureCount };
}
