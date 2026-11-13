import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Which casino database this app talks to.
 * - Built into the app when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set at build time, or
 * - saved on first launch from the setup wizard or a "connection code" (TVB1-…).
 * The public key is safe to share: Row Level Security protects all data.
 */
export interface Connection { url: string; anonKey: string; casino?: string }

const KEY = "tivbook.connection";
const env = import.meta.env;

function load(): Connection | null {
  if (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY) return { url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Connection;
  } catch { /* storage unavailable */ }
  return null;
}

let connection: Connection | null = load();
let client: SupabaseClient | null = null;

export function getConnection() {
  return connection;
}

export function saveConnection(c: Connection) {
  connection = c;
  client = null;
  localStorage.setItem(KEY, JSON.stringify(c));
}

export function forgetConnection() {
  localStorage.removeItem(KEY);
  connection = null;
  client = null;
}

export function supabase(): SupabaseClient {
  if (!connection) throw new Error("TiVBook is not connected to a casino yet.");
  if (!client) {
    client = createClient(connection.url, connection.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: "tivbook.auth" },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }
  return client;
}

/* ───────── connection codes (to connect more PCs and phones) ───────── */

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export function encodeConnection(c: Connection): string {
  return "TVB1-" + b64url(JSON.stringify({ u: c.url, k: c.anonKey, n: c.casino ?? "" }));
}

export function decodeConnection(code: string): Connection | null {
  const m = /TVB1-([A-Za-z0-9_-]+)/.exec(code.trim());
  if (!m) return null;
  try {
    const o = JSON.parse(unb64url(m[1]!)) as { u: string; k: string; n?: string };
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(o.u) || !o.k) return null;
    return { url: o.u, anonKey: o.k, casino: o.n || undefined };
  } catch {
    return null;
  }
}
