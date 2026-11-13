import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { call, encodeConnection, getConnection, useI18n, useRows } from "@tivbook/client";
import { ALL_ROLES, ROLE_LABEL, type Role } from "./roles";
import { installOnline, STEPS } from "./setup/install";
import { openExternal } from "./desktop";

interface StaffRow { user_id: string; email: string; display_name: string; role: Role; active: boolean }

export function StaffPage({ role }: { role: Role }) {
  const { t, lang } = useI18n();
  const { rows, error } = useRows<StaffRow>("staff", null, { order: "created_at", ascending: true });
  const [form, setForm] = useState({ email: "", displayName: "", role: "cashier" as Role, temporaryPassword: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const L = (r: Role) => ROLE_LABEL[r][lang === "fr" ? 1 : 0];
  const assignable = ALL_ROLES.filter((r) => role === "super_admin" || !["super_admin", "manager"].includes(r));

  async function add(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await call("createStaffUser", form);
      setMsg({ ok: true, text: `${form.displayName} — ${form.email} / ${form.temporaryPassword}` });
      setForm({ email: "", displayName: "", role: "cashier", temporaryPassword: "" });
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  }
  async function update(uid: string, data: Record<string, unknown>) {
    try { await call("updateStaffUser", { uid, ...data }); } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={add}>
        <h2>{t("addStaff")}</h2>
        <div className="grid2">
          <div><label>{t("name")}</label><input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></div>
          <div><label>{t("email")}</label><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label>{t("role")}</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{assignable.map((r) => <option key={r} value={r}>{L(r)}</option>)}</select>
          </div>
          <div><label>{t("temporaryPassword")}</label><input required minLength={10} value={form.temporaryPassword} onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })} /></div>
        </div>
        <button>{t("addStaff")}</button>
        {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
      </form>
      {error && <div className="error">{error}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>{t("name")}</th><th>{t("email")}</th><th>{t("role")}</th><th>{t("active")}</th></tr></thead>
          <tbody>
            {rows.map((s) => {
              const editable = role === "super_admin" || !["super_admin", "manager"].includes(s.role);
              return (
                <tr key={s.user_id}>
                  <td>{s.display_name}</td><td>{s.email}</td>
                  <td>{editable
                    ? <select value={s.role} onChange={(e) => void update(s.user_id, { role: e.target.value })}>{assignable.map((r) => <option key={r} value={r}>{L(r)}</option>)}</select>
                    : L(s.role)}</td>
                  <td>{editable
                    ? <button className={s.active ? "secondary" : ""} onClick={() => void update(s.user_id, { active: !s.active })}>{s.active ? t("active") : t("disabled")}</button>
                    : t("active")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface DeviceRow { device_id: string; name: string; platform: string; status: "pending" | "approved" | "revoked"; requested_at: string }

export function DevicesPage() {
  const { t } = useI18n();
  const { rows, error } = useRows<DeviceRow>("staff_devices", null, { order: "requested_at" });
  const [msg, setMsg] = useState<string | null>(null);
  async function set(id: string, status: "approved" | "revoked") {
    setMsg(null);
    try { await call("setDeviceStatus", { targetDeviceId: id, status }); } catch (e) { setMsg((e as Error).message); }
  }
  return (
    <div className="stack">
      {(error || msg) && <div className="error">{error ?? msg}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>{t("name")}</th><th>ID</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.device_id}>
                <td>{d.name || "—"}<div className="small muted">{new Date(d.requested_at).toLocaleString()}</div></td>
                <td className="small muted">{d.device_id.slice(0, 12)}</td>
                <td><span className={`badge ${d.status === "approved" ? "verified" : d.status === "pending" ? "unverified" : "rejected"}`}>{d.status}</span></td>
                <td className="row">
                  {d.status !== "approved" && <button onClick={() => void set(d.device_id, "approved")}>{t("approve")}</button>}
                  {d.status !== "revoked" && <button className="danger" onClick={() => void set(d.device_id, "revoked")}>{t("revoke")}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Connection code/QR for other computers and the player app; WhatsApp and push setup. */
export function SettingsPage({ role }: { role: Role }) {
  const { t } = useI18n();
  const conn = getConnection()!;
  const code = encodeConnection(conn);
  const [qr, setQr] = useState<string>("");
  const [status, setStatus] = useState<{ whatsapp: boolean; push: boolean; template: string } | null>(null);
  const [wa, setWa] = useState({ whatsapp_phone_number_id: "", whatsapp_token: "", whatsapp_template: "tivbook_otp", whatsapp_lang: "en" });
  const [fcm, setFcm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { void QRCode.toDataURL(code, { margin: 1, width: 260, errorCorrectionLevel: "M" }).then(setQr); }, [code]);
  const reload = () => call<typeof status>("getIntegrationStatus").then(setStatus).catch(() => setStatus(null));
  useEffect(() => { void reload(); }, []);

  async function save(data: Record<string, string>) {
    setMsg(null);
    try { await call("setIntegrations", data); setMsg({ ok: true, text: "Saved." }); void reload(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }

  return (
    <div className="grid2">
      <div className="card stack">
        <h2>Connect computers and the player app</h2>
        <p className="muted small">Each new staff computer, and each player's app, needs this code once. Players can scan the QR code (print it for the cashier desk).</p>
        {qr && <img src={qr} alt="Connection QR code" style={{ width: 220, height: 220, background: "#fff", borderRadius: 8, padding: 6 }} />}
        <textarea readOnly rows={3} value={code} onFocus={(e) => e.target.select()} />
        <div className="row">
          <button className="secondary" onClick={() => void navigator.clipboard.writeText(code)}>Copy code</button>
          <button className="secondary" onClick={() => window.print()}>Print QR</button>
        </div>
      </div>
      {role === "super_admin" ? (
        <div className="stack">
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save(wa); }}>
            <div className="row spread"><h2>WhatsApp codes</h2>{status && <span className={`badge ${status.whatsapp ? "verified" : "unverified"}`}>{status.whatsapp ? "Active" : "Not set"}</span>}</div>
            <p className="muted small">From Meta WhatsApp Manager: the Phone Number ID and a permanent access token. The template must be an “Authentication” template with a copy-code button.</p>
            <div><label>Phone Number ID</label><input required value={wa.whatsapp_phone_number_id} onChange={(e) => setWa({ ...wa, whatsapp_phone_number_id: e.target.value })} /></div>
            <div><label>Access token</label><input required type="password" autoComplete="off" value={wa.whatsapp_token} onChange={(e) => setWa({ ...wa, whatsapp_token: e.target.value })} /></div>
            <div className="grid2">
              <div><label>Template name</label><input value={wa.whatsapp_template} onChange={(e) => setWa({ ...wa, whatsapp_template: e.target.value })} /></div>
              <div><label>Template language</label><input value={wa.whatsapp_lang} onChange={(e) => setWa({ ...wa, whatsapp_lang: e.target.value })} /></div>
            </div>
            <button>{t("save")}</button>
          </form>
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save({ fcm_service_account: fcm }); }}>
            <div className="row spread"><h2>Phone alarms (optional)</h2>{status && <span className={`badge ${status.push ? "verified" : "unverified"}`}>{status.push ? "Active" : "Not set"}</span>}</div>
            <p className="muted small">For “place available” alarms on players' phones: paste a Firebase service-account key (free). Without it, players still see offers inside the app.</p>
            <textarea rows={3} value={fcm} onChange={(e) => setFcm(e.target.value)} placeholder='{"type":"service_account", …}' />
            <button disabled={!fcm.trim().startsWith("{")}>{t("save")}</button>
          </form>
          {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
          <UpdateOnline />
        </div>
      ) : <div className="card muted">WhatsApp and alarm settings: Super Administrator only.</div>}
    </div>
  );
}

/** Installs the server and database included in this version of TiVBook Staff (keeps all records). */
function UpdateOnline() {
  const [token, setToken] = useState("");
  const [state, setState] = useState<{ running: boolean; step: string; ok?: boolean; error?: string }>({ running: false, step: "" });
  async function run() {
    setState({ running: true, step: STEPS[0] });
    try {
      await installOnline({ accessToken: token, region: "ap-south-1", casinoName: getConnection()?.casino ?? "Ti Vegas" }, (i, d) => setState({ running: true, step: `${STEPS[i]}${d ? ` — ${d}` : ""}` }));
      setToken("");
      setState({ running: false, step: "", ok: true });
    } catch (e) {
      setState({ running: false, step: "", error: (e as Error).message });
    }
  }
  return (
    <div className="card stack">
      <h2>Update TiVBook online</h2>
      <p className="muted small">After installing a new TiVBook Staff version, run this once on this computer. It updates the online server and database; all records are kept. Needs a new Supabase access token (same steps as the first setup).</p>
      <button type="button" className="link" style={{ alignSelf: "flex-start" }} onClick={() => void openExternal("https://supabase.com/dashboard/account/tokens")}>Open Supabase “Access Tokens”</button>
      <input type="password" autoComplete="off" placeholder="sbp_…" value={token} onChange={(e) => setToken(e.target.value)} disabled={state.running} />
      <button disabled={state.running || !token.trim().startsWith("sbp_")} onClick={() => void run()}>{state.running ? "Updating… keep this window open" : "Update now"}</button>
      {state.running && <p className="small muted">⏳ {state.step}</p>}
      {state.ok && <div className="ok">TiVBook online is up to date. You can delete the access token in Supabase.</div>}
      {state.error && <div className="error">{state.error}</div>}
    </div>
  );
}
