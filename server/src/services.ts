import { createSign } from "node:crypto";
import type { AppMetadata, PushMessage, Services } from "./context.js";

/**
 * Real connections used in production (Supabase Auth & Storage, WhatsApp Cloud API, FCM).
 * Everything goes over HTTPS with the server's own keys — never exposed to the apps.
 */
export interface IntegrationConfig {
  whatsapp: { token?: string; phoneNumberId?: string; template: string; lang: string };
  /** Firebase service-account JSON for push alarms (optional; FCM itself is free). */
  fcmServiceAccount?: string;
}
export interface ServiceConfig {
  supabaseUrl: string;
  serviceKey: string;
  /** Loaded on demand (from the database, entered in TiVBook Staff → Settings). */
  integrations: () => Promise<IntegrationConfig>;
}

const BUCKET = "identity";

export function createServices(cfg: ServiceConfig): Services {
  // New-style secret keys (sb_secret_…) go only in the apikey header; legacy JWT keys also as Bearer.
  const admin: Record<string, string> = cfg.serviceKey.startsWith("sb_")
    ? { apikey: cfg.serviceKey }
    : { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` };
  async function check(res: Response, what: string) {
    if (!res.ok) throw new Error(`${what} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }
  let fcmToken: { value: string; exp: number } | null = null;

  return {
    auth: {
      async userFromToken(token) {
        const res = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, { headers: { apikey: cfg.serviceKey, Authorization: `Bearer ${token}` } });
        if (!res.ok) return null;
        const u = (await res.json()) as { id: string; app_metadata?: AppMetadata };
        return { id: u.id, app_metadata: u.app_metadata ?? {} };
      },
      async createUser(p) {
        const res = await check(await fetch(`${cfg.supabaseUrl}/auth/v1/admin/users`, {
          method: "POST", headers: { ...admin, "Content-Type": "application/json" },
          body: JSON.stringify({ email: p.email, password: p.password, email_confirm: true, app_metadata: p.app_metadata, user_metadata: p.display_name ? { display_name: p.display_name } : {} }),
        }), "create user");
        return { id: ((await res.json()) as { id: string }).id };
      },
      async updateUser(id, p) {
        const body: Record<string, unknown> = {};
        if (p.password) body.password = p.password;
        if (p.app_metadata) body.app_metadata = p.app_metadata;
        if (p.banned !== undefined) body.ban_duration = p.banned ? "876000h" : "none";
        await check(await fetch(`${cfg.supabaseUrl}/auth/v1/admin/users/${id}`, { method: "PUT", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), "update user");
      },
    },
    storage: {
      async upload(path, bytes, contentType) {
        await check(await fetch(`${cfg.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
          method: "POST", headers: { ...admin, "Content-Type": contentType, "x-upsert": "false", "cache-control": "no-store" }, body: new Blob([bytes as BlobPart]),
        }), "upload");
      },
      async download(path) {
        const res = await check(await fetch(`${cfg.supabaseUrl}/storage/v1/object/authenticated/${BUCKET}/${path}`, { headers: admin }), "download");
        return new Uint8Array(await res.arrayBuffer());
      },
    },
    whatsapp: {
      async isConfigured() {
        const w = (await cfg.integrations()).whatsapp;
        return !!(w.token && w.phoneNumberId);
      },
      async sendOtp(phoneE164, code) {
        const { token, phoneNumberId, template, lang } = (await cfg.integrations()).whatsapp;
        if (!token || !phoneNumberId) throw new Error("WhatsApp is not configured.");
        const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp", to: phoneE164.replace("+", ""), type: "template",
            template: {
              name: template, language: { code: lang },
              components: [
                { type: "body", parameters: [{ type: "text", text: code }] },
                { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
              ],
            },
          }),
        });
        await check(res, "WhatsApp send");
      },
    },
    push: {
      async send(tokens: string[], msg: PushMessage) {
        const fcm = (await cfg.integrations()).fcmServiceAccount;
        if (!fcm) return { sent: 0, failed: 0 };
        const sa = JSON.parse(fcm) as { client_email: string; private_key: string; project_id: string };
        const now = Math.floor(Date.now() / 1000);
        if (!fcmToken || fcmToken.exp < now + 60) {
          const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
          const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
          const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
          const res = await check(await fetch("https://oauth2.googleapis.com/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
          }), "FCM auth");
          fcmToken = { value: ((await res.json()) as { access_token: string }).access_token, exp: now + 3500 };
        }
        const urgent = msg.channel === "place_available";
        let sent = 0, failed = 0;
        for (const token of tokens) {
          const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
            method: "POST", headers: { Authorization: `Bearer ${fcmToken.value}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              message: {
                token, notification: { title: msg.title, body: msg.body }, data: { channel: msg.channel, ...(msg.data ?? {}) },
                android: { priority: "HIGH", notification: { channel_id: msg.channel, sound: urgent ? "tivbook_place_available" : "default" } },
                apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: urgent ? "tivbook_place_available.caf" : "default", "interruption-level": urgent ? "time-sensitive" : "active" } } },
              },
            }),
          });
          res.ok ? sent++ : failed++;
        }
        return { sent, failed };
      },
    },
  };
}
