import { FUNCTION_SOURCE, SCHEMA_SQL, SERVER_VERSION } from "./generated/bundle";
import { desktop } from "../desktop";

/**
 * One-click online installation, driven from TiVBook Staff on the first computer.
 * Uses the Supabase Management API with a personal access token that is kept in
 * memory only for the duration of the setup and never saved.
 */
export const REGIONS = [
  { id: "ap-south-1", label: "Mumbai (closest to Mauritius)" },
  { id: "ap-southeast-1", label: "Singapore" },
  { id: "eu-central-1", label: "Frankfurt" },
  { id: "eu-west-2", label: "London" },
] as const;

export interface InstallInput {
  accessToken: string;
  region: string;
  casinoName: string;
  /** Omitted when updating an existing installation. */
  admin?: { email: string; password: string; displayName: string };
}
export interface InstallResult { url: string; anonKey: string; projectRef: string }
export type Progress = (step: number, detail?: string) => void;

export const STEPS = [
  "Checking your Supabase account",
  "Creating the TiVBook database (1–3 minutes)",
  "Installing tables and security rules",
  "Generating security keys",
  "Installing the TiVBook server",
  "Locking sign-ups and starting the every-minute timer",
  "Creating your administrator account",
] as const;

const API = "https://api.supabase.com/v1";

interface Req { method?: string; headers?: Record<string, string>; body?: string; multipart?: Array<{ name: string; value: string; filename?: string; type?: string }> }
interface Res { status: number; ok: boolean; text: string }

/** In the Windows app, requests go through the desktop bridge (no browser restrictions). */
async function xfetch(url: string, init: Req = {}): Promise<Res> {
  const d = desktop();
  if (d) return d.request({ url, ...init });
  let body: BodyInit | undefined = init.body;
  if (init.multipart) {
    const f = new FormData();
    for (const p of init.multipart) f.append(p.name, new Blob([p.value], { type: p.type ?? "text/plain" }), p.filename);
    body = f;
  }
  const r = await fetch(url, { method: init.method, headers: init.headers, body });
  return { status: r.status, ok: r.ok, text: await r.text() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function random(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class InstallError extends Error {}

export async function installOnline(input: InstallInput, progress: Progress): Promise<InstallResult> {
  const token = input.accessToken.trim();
  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Res;
    try {
      res = await xfetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new InstallError(desktop() ? "No internet connection to Supabase. Check the internet and try again." : "This browser blocked the request. Run the first-time setup from the TiVBook Staff Windows app.");
    }
    const text = res.text;
    if (res.status === 401) throw new InstallError("The access token is not valid. Create a new one and paste it again.");
    if (!res.ok) throw new InstallError(`Supabase said: ${extract(text) || res.status}`);
    return (text ? JSON.parse(text) : null) as T;
  }
  const sql = (ref: string, query: string) => api("POST", `/projects/${ref}/database/query`, { query });

  // 1. Account
  progress(0);
  const orgs = await api<Array<{ id: string; slug?: string; name: string }>>("GET", "/organizations");
  if (!orgs.length) throw new InstallError("Your Supabase account has no organization yet. Open supabase.com, finish creating your account, then try again.");
  const projects = await api<Array<{ id: string; ref?: string; name: string; status: string }>>("GET", "/projects");

  // 2. Project (re-uses an existing "tivbook" project if setup is run again)
  progress(1);
  let project = projects.find((p) => p.name === "tivbook");
  if (!project) {
    const org = orgs[0]!.slug ?? orgs[0]!.id;
    const base = { name: "tivbook", db_pass: random(20), organization_slug: org };
    try {
      try {
        project = await api("POST", "/projects", { ...base, region_selection: { type: "specific", code: input.region } });
      } catch (first) {
        if (/limit|free|maximum/i.test((first as Error).message)) throw first;
        // Older form of the same request
        project = await api("POST", "/projects", { ...base, organization_id: org, region: input.region });
      }
    } catch (e) {
      const msg = (e as Error).message;
      throw new InstallError(/limit|free/i.test(msg) ? "Your Supabase account already has 2 free projects (the free maximum). Delete one at supabase.com, then try again." : msg);
    }
  }
  const ref = (project!.ref ?? project!.id) as string;
  for (let i = 0; ; i++) {
    const p = await api<{ status: string }>("GET", `/projects/${ref}`);
    if (p.status === "ACTIVE_HEALTHY") break;
    if (i > 90) throw new InstallError("The database is taking too long to start. Wait a few minutes and run setup again — it will continue where it stopped.");
    progress(1, p.status.replace(/_/g, " ").toLowerCase());
    await sleep(5000);
  }

  // 3. Database
  progress(2);
  for (let i = 0; ; i++) {
    try { await sql(ref, SCHEMA_SQL); break; } catch (e) { if (i >= 5) throw e; await sleep(5000); }
  }

  // 4. Secrets for the server (ticket signing, OTP protection, setup code, timer)
  progress(3);
  const setupCode = random(24);
  const cronSecret = random(24);
  const existing = await api<Array<{ name: string }>>("GET", `/projects/${ref}/secrets`).catch(() => [] as Array<{ name: string }>);
  const has = (n: string) => existing.some((s) => s.name === n);
  await api("POST", `/projects/${ref}/secrets`, [
    ...(has("TICKET_SECRET") ? [] : [{ name: "TICKET_SECRET", value: random(32) }]),
    ...(has("OTP_PEPPER") ? [] : [{ name: "OTP_PEPPER", value: random(32) }]),
    { name: "SETUP_CODE", value: setupCode },
    { name: "CRON_SECRET", value: cronSecret },
  ]);

  // 5. Server function
  progress(4);
  const dep = await xfetch(`${API}/projects/${ref}/functions/deploy?slug=api`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
    multipart: [
      { name: "metadata", value: JSON.stringify({ entrypoint_path: "index.ts", name: "api", verify_jwt: false }), type: "application/json" },
      { name: "file", value: FUNCTION_SOURCE, filename: "index.ts", type: "application/typescript" },
    ],
  });
  if (!dep.ok) throw new InstallError(`Could not install the TiVBook server: ${extract(dep.text) || dep.status}`);

  // Keys: the public key goes into the apps; the secret key stays on the server only.
  type Key = { name: string; type?: string; api_key: string };
  let keys = await api<Key[]>("GET", `/projects/${ref}/api-keys?reveal=true`);
  let anon = keys.find((k) => k.type === "publishable")?.api_key ?? keys.find((k) => k.name === "anon")?.api_key;
  let secretKey = keys.find((k) => k.type === "secret")?.api_key ?? keys.find((k) => k.name === "service_role")?.api_key;
  if (!anon) { await api("POST", `/projects/${ref}/api-keys`, { type: "publishable", name: "tivbook" }); }
  if (!secretKey) { await api("POST", `/projects/${ref}/api-keys?reveal=true`, { type: "secret", name: "tivbook_server" }); }
  if (!anon || !secretKey) {
    keys = await api<Key[]>("GET", `/projects/${ref}/api-keys?reveal=true`);
    anon = keys.find((k) => k.type === "publishable")?.api_key ?? keys.find((k) => k.name === "anon")?.api_key;
    secretKey = keys.find((k) => k.type === "secret")?.api_key ?? keys.find((k) => k.name === "service_role")?.api_key;
  }
  if (!anon || !secretKey) throw new InstallError("Could not read the project's keys.");
  await api("POST", `/projects/${ref}/secrets`, [{ name: "TIVBOOK_SERVICE_KEY", value: secretKey }]);
  const url = `https://${ref}.supabase.co`;

  // 6. Auth: only TiVBook can create accounts; every-minute timer for expiries and alarms
  progress(5);
  await api("PATCH", `/projects/${ref}/config/auth`, { disable_signup: true, site_url: url });
  await sql(ref, cronSql(url, anon, cronSecret));

  // 7. Administrator (server must be up first; skipped when updating)
  progress(6);
  if (!input.admin) {
    for (let i = 0; ; i++) {
      const r = await xfetch(`${url}/functions/v1/api`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon }, body: JSON.stringify({ action: "ping" }) }).catch(() => null);
      if (r?.ok && r.text.includes(SERVER_VERSION)) break;
      if (i > 24) throw new InstallError("The updated TiVBook server did not start. Run the update again.");
      await sleep(5000);
    }
    await api("POST", `/projects/${ref}/secrets`, [{ name: "SETUP_CODE", value: random(24) }]);
    return { url, anonKey: anon, projectRef: ref };
  }
  for (let i = 0; ; i++) {
    const r = await xfetch(`${url}/functions/v1/api`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon }, body: JSON.stringify({ action: "ping" }) }).catch(() => null);
    if (r?.ok) break;
    if (i > 24) throw new InstallError("The TiVBook server did not start. Run setup again.");
    await sleep(5000);
  }
  const boot = await xfetch(`${url}/functions/v1/api`, {
    method: "POST", headers: { "Content-Type": "application/json", apikey: anon },
    body: JSON.stringify({ action: "bootstrapSuperAdmin", data: { setupCode, email: input.admin.email, password: input.admin.password, displayName: input.admin.displayName } }),
  });
  let bootBody: { ok?: boolean; error?: { code: string; message: string } } = {};
  try { bootBody = JSON.parse(boot.text); } catch { /* handled below */ }
  if (!bootBody.ok && bootBody.error?.code !== "ALREADY_SET_UP") throw new InstallError(bootBody.error?.message ?? "Could not create the administrator.");
  // The setup code is single-use: replace it with a random value nobody knows.
  await api("POST", `/projects/${ref}/secrets`, [{ name: "SETUP_CODE", value: random(24) }]);
  if (bootBody.error?.code === "ALREADY_SET_UP") progress(6, "an administrator already exists — sign in with that account");

  return { url, anonKey: anon, projectRef: ref };
}

function cronSql(url: string, anon: string, secret: string) {
  const headers = JSON.stringify({ "Content-Type": "application/json", apikey: anon, "x-cron-secret": secret }).replace(/'/g, "''");
  return `
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'tivbook-every-minute';
select cron.schedule('tivbook-every-minute', '* * * * *', $job$
  select net.http_post(url := '${url}/functions/v1/api', headers := '${headers}'::jsonb, body := '{"action":"cronTick"}'::jsonb);
$job$);`;
}

function extract(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string; msg?: string; error?: string };
    return j.message ?? j.msg ?? j.error ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
