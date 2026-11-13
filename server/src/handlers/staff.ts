import { timingSafeEqual } from "node:crypto";
import { INTEGRATION_KEYS, STAFF_ROLES, type Handler, type IntegrationKey, type Role } from "../context.js";
import { ApiError, audit, denied, fail, isStaff, isUniqueViolation, requireRole, signedIn, str } from "../util.js";

/** Managers may create every role except Super Administrator and Manager. */
const canAssign = (actor: Role, target: Role) => actor === "super_admin" || (actor === "manager" && !["super_admin", "manager"].includes(target));

export const createStaffUser: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, ["super_admin", "manager"]);
  const email = str(d.email, "email", 120).toLowerCase();
  const displayName = str(d.displayName, "displayName", 80);
  const role = d.role as Role;
  if (!STAFF_ROLES.includes(role)) fail("INVALID_ARGUMENT", "Unknown role.");
  if (!canAssign(c.role, role)) denied("You cannot create this role.");
  const password = str(d.temporaryPassword, "temporaryPassword", 64);
  if (password.length < 10) fail("WEAK_PASSWORD", "Temporary password must be at least 10 characters.");
  const [exists] = await ctx.sql`select 1 from staff where email = ${email}`;
  if (exists) fail("EMAIL_EXISTS", "A staff account with this email already exists.");
  const user = await ctx.services.auth.createUser({ email, password, app_metadata: { role }, display_name: displayName });
  await ctx.sql`insert into staff (user_id, email, display_name, role, active, must_change_password, created_by)
    values (${user.id}, ${email}, ${displayName}, ${role}, true, true, ${c.uid})`;
  await audit(ctx.sql, { actor: c.uid, action: "staff.create", entity: `staff/${user.id}`, after: { role }, deviceId: c.deviceId });
  return { uid: user.id };
};

export const updateStaffUser: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, ["super_admin", "manager"]);
  const uid = str(d.uid, "uid", 64);
  if (uid === c.uid) fail("SELF", "You cannot change your own account.");
  const [s] = await ctx.sql`select * from staff where user_id = ${uid}`;
  if (!s) throw new ApiError("NOT_FOUND", "Staff member not found.", 404);
  if (!canAssign(c.role, s.role as Role)) denied("Not allowed for this account.");
  const role = d.role as Role | undefined;
  if (role !== undefined) {
    if (!STAFF_ROLES.includes(role) || !canAssign(c.role, role)) denied("You cannot assign this role.");
    await ctx.services.auth.updateUser(uid, { app_metadata: { role } });
    await ctx.sql`update staff set role = ${role} where user_id = ${uid}`;
  }
  if (typeof d.active === "boolean") {
    await ctx.services.auth.updateUser(uid, { banned: !d.active });
    await ctx.sql`update staff set active = ${d.active} where user_id = ${uid}`;
  }
  await audit(ctx.sql, { actor: c.uid, action: "staff.update", entity: `staff/${uid}`, before: { role: s.role, active: s.active }, after: { role, active: d.active }, deviceId: c.deviceId });
  return { ok: true };
};

/** First use of the staff software on a PC/phone. A Super Administrator's own device is approved at once. */
export const requestDeviceApproval: Handler = async (ctx, d) => {
  const c = signedIn(ctx);
  if (!isStaff(c.role)) denied("Staff only.");
  const deviceId = str(d.deviceId, "deviceId", 64);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) fail("INVALID_ARGUMENT", "Invalid device id.");
  const [existing] = await ctx.sql`select status from staff_devices where device_id = ${deviceId}`;
  if (existing) return { status: existing.status };
  const status = c.role === "super_admin" ? "approved" : "pending";
  await ctx.sql`insert into staff_devices (device_id, name, platform, status, requested_by, approved_by, approved_at)
    values (${deviceId}, ${String(d.name ?? "").slice(0, 60)}, ${String(d.platform ?? "").slice(0, 40)}, ${status}, ${c.uid},
            ${status === "approved" ? c.uid : null}, ${status === "approved" ? new Date() : null})
    on conflict (device_id) do nothing`;
  await audit(ctx.sql, { actor: c.uid, action: `device.request.${status}`, entity: `staff_devices/${deviceId}` });
  return { status };
};

export const setDeviceStatus: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, ["super_admin", "manager"]);
  const id = str(d.targetDeviceId, "targetDeviceId", 64);
  const status = d.status;
  if (status !== "approved" && status !== "revoked") fail("INVALID_ARGUMENT", "status must be approved or revoked.");
  if (id === c.deviceId && status === "revoked") fail("SELF", "You cannot revoke the device you are using.");
  const res = status === "approved"
    ? await ctx.sql`update staff_devices set status = 'approved', approved_by = ${c.uid}, approved_at = now() where device_id = ${id}`
    : await ctx.sql`update staff_devices set status = 'revoked', revoked_by = ${c.uid}, revoked_at = now() where device_id = ${id}`;
  if (res.count === 0) throw new ApiError("NOT_FOUND", "Device not found.", 404);
  await audit(ctx.sql, { actor: c.uid, action: `device.${status}`, entity: `staff_devices/${id}`, deviceId: c.deviceId });
  return { ok: true };
};

/** Clears the first-login flag once the staff member has chosen a password. */
export const passwordChanged: Handler = async (ctx) => {
  const c = signedIn(ctx);
  if (!isStaff(c.role)) denied("Staff only.");
  await ctx.sql`update staff set must_change_password = false, password_changed_at = now() where user_id = ${c.uid}`;
  return { ok: true };
};

/**
 * Creates the first Super Administrator. Used once by the setup wizard:
 * only with the setup code, and only while no staff account exists.
 */
export const bootstrapSuperAdmin: Handler = async (ctx, d) => {
  const expected = ctx.env.SETUP_CODE ?? "";
  const given = String(d.setupCode ?? "");
  if (!expected || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) denied("Invalid setup code.");
  const email = str(d.email, "email", 120).toLowerCase();
  const password = str(d.password, "password", 128);
  if (password.length < 10) fail("WEAK_PASSWORD", "Password must be at least 10 characters.");
  const displayName = typeof d.displayName === "string" && d.displayName.trim() ? d.displayName.trim().slice(0, 80) : "Super Administrator";
  try {
    await ctx.sql`insert into counters (name, value) values ('bootstrap', 1)`; // only ever succeeds once
  } catch (e) {
    if (isUniqueViolation(e)) fail("ALREADY_SET_UP", "Setup already completed.");
    throw e;
  }
  const [any] = await ctx.sql`select 1 from staff limit 1`;
  if (any) fail("ALREADY_SET_UP", "Setup already completed.");
  const user = await ctx.services.auth.createUser({ email, password, app_metadata: { role: "super_admin" }, display_name: displayName });
  await ctx.sql`insert into staff (user_id, email, display_name, role, active, must_change_password, created_by)
    values (${user.id}, ${email}, ${displayName}, 'super_admin', true, false, 'setup')`;
  await audit(ctx.sql, { actor: "setup", action: "staff.bootstrap", entity: `staff/${user.id}` });
  return { uid: user.id };
};

/** Super Administrator saves WhatsApp / push credentials. Values are write-only for apps. */
export const setIntegrations: Handler = async (ctx, d) => {
  const c = await requireRole(ctx, ["super_admin"]);
  const changed: string[] = [];
  for (const k of INTEGRATION_KEYS) {
    const v = d[k];
    if (typeof v !== "string") continue;
    if (v.trim() === "") await ctx.sql`delete from integration_settings where key = ${k}`;
    else await ctx.sql`insert into integration_settings (key, value, updated_by) values (${k}, ${v.trim().slice(0, 8000)}, ${c.uid})
      on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
    changed.push(k);
  }
  await audit(ctx.sql, { actor: c.uid, action: "integrations.update", entity: "integration_settings", after: { changed }, deviceId: c.deviceId });
  return { ok: true };
};

/** Which integrations are configured (never returns the secret values). */
export const getIntegrationStatus: Handler = async (ctx) => {
  await requireRole(ctx, ["super_admin", "manager"]);
  const rows = await ctx.sql`select key, updated_at from integration_settings`;
  const has = (k: IntegrationKey) => rows.some((r) => r.key === k);
  return {
    whatsapp: has("whatsapp_token") && has("whatsapp_phone_number_id"),
    push: has("fcm_service_account"),
    template: (await ctx.sql`select value from integration_settings where key = 'whatsapp_template'`)[0]?.value ?? "tivbook_otp",
  };
};
