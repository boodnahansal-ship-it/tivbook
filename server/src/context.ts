import type { Sql, TransactionSql } from "postgres";

export type Role =
  | "super_admin" | "manager" | "tournament_director" | "cashier" | "floor_supervisor" | "dealer" | "front_desk" | "player";

export const STAFF_ROLES: Role[] = ["super_admin", "manager", "tournament_director", "cashier", "floor_supervisor", "dealer", "front_desk"];
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
  phoneE164?: string;
  phoneVerified?: boolean;
  /** Staff computer/phone id, sent with each request; must be approved. */
  deviceId?: string;
}

export interface AppMetadata { role?: Role; player_id?: string; phone_e164?: string; phone_verified?: boolean }

/** Everything outside the database, so it can be replaced in tests. */
export interface Services {
  auth: {
    /** Resolves a login token to the user (null if invalid/expired). */
    userFromToken(token: string): Promise<{ id: string; app_metadata: AppMetadata } | null>;
    createUser(p: { email: string; password: string; app_metadata: AppMetadata; display_name?: string }): Promise<{ id: string }>;
    updateUser(id: string, p: { password?: string; app_metadata?: AppMetadata; banned?: boolean }): Promise<void>;
  };
  storage: {
    upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
    download(path: string): Promise<Uint8Array>;
  };
  whatsapp: { isConfigured(): Promise<boolean>; sendOtp(phoneE164: string, code: string): Promise<void> };
  push: { send(tokens: string[], msg: PushMessage): Promise<{ sent: number; failed: number }> };
}

export interface PushMessage { title: string; body: string; channel: "place_available" | "reminders"; data?: Record<string, string> }

export const INTEGRATION_KEYS = ["whatsapp_token", "whatsapp_phone_number_id", "whatsapp_template", "whatsapp_lang", "fcm_service_account"] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export interface Env {
  TICKET_SECRET: string;
  OTP_PEPPER: string;
  SETUP_CODE?: string;
  CRON_SECRET?: string;
}

export interface Ctx {
  sql: Sql;
  caller: Caller | null;
  env: Env;
  services: Services;
  ip: string;
  now: () => number;
  /** Set by the HTTP layer for the scheduled job. */
  cronAuthorized?: boolean;
}

export type Tx = TransactionSql;
export type Handler = (ctx: Ctx, data: Record<string, unknown>) => Promise<unknown>;
