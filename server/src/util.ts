import type { Sql } from "postgres";
import { STAFF_ROLES, type Caller, type Ctx, type Role, type Tx } from "./context.js";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: Record<string, unknown>) {
    super(message);
  }
}
export function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ApiError(code, message, 400, details);
}
export function denied(message = "Your account is not allowed to do this.", code = "PERMISSION_DENIED"): never {
  throw new ApiError(code, message, 403);
}

export function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new ApiError("INVALID_ARGUMENT", `${name} is required.`);
  return v.trim();
}

export function signedIn(ctx: Ctx): Caller {
  if (!ctx.caller) throw new ApiError("UNAUTHENTICATED", "Please sign in.", 401);
  return ctx.caller;
}

export const isStaff = (r: Role) => STAFF_ROLES.includes(r);

/** Throws unless the caller is active staff on an approved device. */
export async function assertStaffDevice(sql: Sql | Tx, c: Caller): Promise<void> {
  if (!c.deviceId) denied("This device is not authorized for staff use.", "DEVICE_NOT_APPROVED");
  const [row] = await sql`
    select d.status, s.active from staff_devices d, staff s
    where d.device_id = ${c.deviceId!} and s.user_id = ${c.uid}`;
  if (!row) {
    const [s] = await sql`select active from staff where user_id = ${c.uid}`;
    if (!s?.active) denied("Your staff account is disabled.");
    denied("This device is waiting for administrator approval.", "DEVICE_NOT_APPROVED");
  }
  if (!row!.active) denied("Your staff account is disabled.");
  if (row!.status !== "approved") denied("This device is waiting for administrator approval.", "DEVICE_NOT_APPROVED");
}

export async function requireRole(ctx: Ctx, roles: Role[]): Promise<Caller> {
  const c = signedIn(ctx);
  if (!roles.includes(c.role)) denied();
  if (isStaff(c.role)) await assertStaffDevice(ctx.sql, c);
  return c;
}

/** A player acting for themself, or approved staff acting for a given player. */
export async function resolvePlayerId(ctx: Ctx, requested: unknown, staffRoles: Role[]): Promise<string> {
  const c = signedIn(ctx);
  if (c.role === "player") {
    if (!c.playerId) fail("NOT_REGISTERED", "Complete your registration first.");
    if (requested && requested !== c.playerId) denied("You can only act for your own account.");
    return c.playerId!;
  }
  if (!staffRoles.includes(c.role)) denied();
  await assertStaffDevice(ctx.sql, c);
  return str(requested, "playerId", 12);
}

export async function audit(sql: Sql | Tx, e: { actor: string; action: string; entity: string; authorizer?: string; before?: unknown; after?: unknown; deviceId?: string }) {
  await sql`insert into audit_logs (actor, action, entity, authorizer, before, after, device_id)
    values (${e.actor}, ${e.action}, ${e.entity}, ${e.authorizer ?? null}, ${e.before === undefined ? null : sql.json(e.before as never)},
            ${e.after === undefined ? null : sql.json(e.after as never)}, ${e.deviceId ?? null})`;
}

export async function getSetting<T>(sql: Sql | Tx, key: string, fallback: T): Promise<T> {
  const [row] = await sql`select value from settings where key = ${key}`;
  return row ? { ...fallback, ...(row.value as Partial<T>) } : fallback;
}

/** Postgres unique-violation → friendly error. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint_name?: string };
  return err?.code === "23505" && (!constraint || err.constraint_name === constraint);
}

export const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v));
export const isoDate = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export function randomSecret(bytes = 24): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
