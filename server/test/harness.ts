import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AppMetadata, Caller, Ctx, PushMessage, Role, Services } from "../src/context.js";
import { dispatch } from "../src/router.js";

/**
 * Integration-test harness: a real, empty PostgreSQL database with the TiVBook schema,
 * plus in-memory stand-ins for Supabase Auth/Storage, WhatsApp and push.
 * Set TIVBOOK_TEST_PG (default postgres://postgres:pw@localhost:5432/postgres).
 */
const ADMIN_URL = process.env.TIVBOOK_TEST_PG ?? "postgres://postgres:pw@localhost:5432/postgres";

export async function createTestDb(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const name = `tv_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const sql = postgres(url, { max: 12, onnotice: () => {} });
  await sql.unsafe(readFileSync(new URL("../sql/test-stubs.sql", import.meta.url), "utf8"));
  await sql.unsafe(readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8"));
  // Like Supabase: app roles have table privileges; Row Level Security decides what they see.
  await sql.unsafe("grant all on all tables in schema public to authenticated; grant usage on all sequences in schema public to authenticated");
  return {
    sql,
    drop: async () => {
      await sql.end();
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

export class Fakes {
  users = new Map<string, { email: string; password: string; app_metadata: AppMetadata; banned?: boolean }>();
  files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  sentCodes: Array<{ phone: string; code: string }> = [];
  pushes: Array<{ tokens: string[]; msg: PushMessage }> = [];
  whatsappDown = false;
  whatsappConfigured = true;

  services(): Services {
    return {
      auth: {
        userFromToken: async () => null,
        createUser: async (p) => {
          const id = randomUUID();
          this.users.set(id, { email: p.email, password: p.password, app_metadata: p.app_metadata });
          return { id };
        },
        updateUser: async (id, p) => {
          const u = this.users.get(id);
          if (!u) throw new Error("no user");
          if (p.password) u.password = p.password;
          if (p.app_metadata) u.app_metadata = { ...u.app_metadata, ...p.app_metadata };
          if (p.banned !== undefined) u.banned = p.banned;
        },
      },
      storage: {
        upload: async (path, bytes, contentType) => void this.files.set(path, { bytes, contentType }),
        download: async (path) => {
          const f = this.files.get(path);
          if (!f) throw new Error("missing");
          return f.bytes;
        },
      },
      whatsapp: {
        isConfigured: async () => this.whatsappConfigured,
        sendOtp: async (phone, code) => {
          if (this.whatsappDown) throw new Error("down");
          this.sentCodes.push({ phone, code });
        },
      },
      push: { send: async (tokens, msg) => (this.pushes.push({ tokens, msg }), { sent: tokens.length, failed: 0 }) },
    };
  }

  /** Caller as the server would build it from that user's login token. */
  callerFor(uid: string, deviceId?: string): Caller {
    const m = this.users.get(uid)!.app_metadata;
    return { uid, role: (m.role ?? "player") as Role, playerId: m.player_id, phoneE164: m.phone_e164, phoneVerified: m.phone_verified === true, deviceId };
  }
}

export class World {
  clock = Date.parse("2026-11-16T08:00:00Z"); // Monday 12:00 Mauritius
  fakes = new Fakes();
  constructor(public sql: Sql) {}
  ctx(caller: Caller | null, extra: Partial<Ctx> = {}): Ctx {
    return {
      sql: this.sql, caller, services: this.fakes.services(), ip: "10.0.0.1", now: () => this.clock,
      env: { TICKET_SECRET: "t".repeat(64), OTP_PEPPER: "o".repeat(64), SETUP_CODE: "setup-code-123456", CRON_SECRET: "cron" },
      ...extra,
    };
  }
  /** Calls an action; returns data or throws an Error whose message is the error code. */
  async call<T = any>(caller: Caller | null, action: string, data: Record<string, unknown> = {}, extra: Partial<Ctx> = {}): Promise<T> {
    const r = await dispatch(this.ctx(caller, extra), action, data);
    if (!r.body.ok) throw Object.assign(new Error(r.body.error.code), { reply: r.body.error, status: r.status });
    return r.body.data as T;
  }
  async code(caller: Caller | null, action: string, data: Record<string, unknown> = {}): Promise<string> {
    try {
      await this.call(caller, action, data);
      return "OK";
    } catch (e) {
      return (e as Error).message;
    }
  }
}
