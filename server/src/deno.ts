/**
 * Supabase Edge Function entry point ("api").
 * Bundled by build.mjs into a single file that the setup wizard uploads.
 */
// @ts-ignore — resolved by Deno at runtime
import postgres from "npm:postgres@3.4.5";
import type { Caller, Ctx, Env, Role } from "./context.js";
import { dispatch } from "./router.js";
import { createServices, type IntegrationConfig } from "./services.js";

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Response | Promise<Response>): void };
const env = (k: string) => Deno.env.get(k) ?? "";

const sql = postgres(env("SUPABASE_DB_URL"), { prepare: false, max: 4, idle_timeout: 20 });
// WhatsApp / push credentials come from TiVBook Staff → Settings (cached for one minute).
let cache: { at: number; value: IntegrationConfig } | null = null;
async function integrations(): Promise<IntegrationConfig> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const rows: Array<{ key: string; value: string }> = await sql`select key, value from integration_settings`;
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const value: IntegrationConfig = {
    whatsapp: { token: get("whatsapp_token"), phoneNumberId: get("whatsapp_phone_number_id"), template: get("whatsapp_template") || "tivbook_otp", lang: get("whatsapp_lang") || "en" },
    fcmServiceAccount: get("fcm_service_account"),
  };
  cache = { at: Date.now(), value };
  return value;
}
// Secret key set by the setup wizard (works with both new and legacy Supabase keys).
const serviceKey = env("TIVBOOK_SERVICE_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
const services = createServices({ supabaseUrl: env("SUPABASE_URL"), serviceKey, integrations });
const appEnv: Env = { TICKET_SECRET: env("TICKET_SECRET"), OTP_PEPPER: env("OTP_PEPPER"), SETUP_CODE: env("SETUP_CODE") || undefined, CRON_SECRET: env("CRON_SECRET") || undefined };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, error: { code: "METHOD", message: "POST only" } });
  let body: { action?: string; data?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json(400, { ok: false, error: { code: "BAD_JSON", message: "Invalid request" } }); }

  let caller: Caller | null = null;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  // Only signed-in users send a login token (a JWT); public keys are ignored here.
  if (token && token.split(".").length === 3 && token !== env("SUPABASE_ANON_KEY")) {
    const user = await services.auth.userFromToken(token);
    if (user) {
      const m = user.app_metadata;
      caller = {
        uid: user.id, role: (m.role ?? "player") as Role, playerId: m.player_id, phoneE164: m.phone_e164, phoneVerified: m.phone_verified === true,
        deviceId: typeof body.data?.deviceId === "string" ? (body.data.deviceId as string) : undefined,
      };
    }
  }
  const cronSecret = req.headers.get("x-cron-secret");
  const ctx: Ctx = {
    sql, caller, env: appEnv, services, now: () => Date.now(),
    ip: (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown",
    cronAuthorized: !!appEnv.CRON_SECRET && cronSecret === appEnv.CRON_SECRET,
  };
  const { status, body: reply } = await dispatch(ctx, String(body.action ?? ""), body.data ?? {});
  return json(status, reply);
});
