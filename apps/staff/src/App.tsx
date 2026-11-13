import { useEffect, useState, type FormEvent } from "react";
import { call, ConnectScreen, getConnection, setDeviceId, supabase, useI18n, useOnline, useRow, useSession, type Lang, type TKey } from "@tivbook/client";
import { PlayersPage } from "./PlayersPage";
import { DevicesPage, SettingsPage, StaffPage } from "./AdminPages";
import { SetupWizard } from "./setup/SetupWizard";
import { DeskCodesPage } from "./DeskCodesPage";
import { ROLE_LABEL, type Role } from "./roles";

const signOut = () => void supabase().auth.signOut();

/* ───────── This computer's identity ───────── */

function localDeviceId(): string {
  const KEY = "tivbook.deviceId";
  let id = localStorage.getItem(KEY);
  if (!id) {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    id = "dev_" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** Not connected yet → connect with a code, or (first computer) run the one-click setup. */
export function App() {
  const [connected, setConnected] = useState(!!getConnection());
  const [setup, setSetup] = useState(false);
  if (setup) return <SetupWizard onDone={() => { setSetup(false); setConnected(true); }} onCancel={() => setSetup(false)} />;
  if (!connected) {
    return (
      <ConnectScreen
        onConnected={() => setConnected(true)}
        extra={
          <div className="card stack">
            <h2>First computer at the casino?</h2>
            <p className="muted small">Set up TiVBook online in one click. It creates the casino's free online database and your administrator account.</p>
            <button className="block" onClick={() => setSetup(true)}>Set up TiVBook for the casino</button>
          </div>
        }
      />
    );
  }
  return <Connected />;
}

function Connected() {
  const s = useSession();
  const { t } = useI18n();
  if (!s.ready) return <div className="page center muted" style={{ paddingTop: "30vh" }}>{t("loading")}</div>;
  if (!s.user) return <SignIn />;
  const role = s.claims.role as Role | undefined;
  if (!role || role === ("player" as Role)) {
    return (
      <div className="page stack" style={{ paddingTop: "20vh" }}>
        <div className="error">This account is not a staff account.</div>
        <button className="secondary" onClick={signOut}>{t("signOut")}</button>
      </div>
    );
  }
  return <StaffGate uid={s.user.id} role={role} />;
}

function SignIn() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error: e2 } = await supabase().auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (e2) { setError(/fetch|network/i.test(e2.message) ? "No internet connection." : "Incorrect email or password."); setBusy(false); }
  }
  return (
    <div className="page" style={{ paddingTop: "12vh" }}>
      <form className="card stack" onSubmit={submit}>
        <div className="center"><div className="brand" style={{ fontSize: "2rem" }}>TiVBook</div><p className="muted">Ti Vegas — Staff</p></div>
        <div><label htmlFor="em">{t("email")}</label><input id="em" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label htmlFor="pw">{t("password")}</label><input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error && <div className="error">{error}</div>}
        <button className="block" disabled={busy}>{t("signIn")}</button>
      </form>
    </div>
  );
}

/** First-login password change + device approval, then the dashboard. */
function StaffGate({ uid, role }: { uid: string; role: Role }) {
  const { t } = useI18n();
  const staff = useRow<{ display_name: string; must_change_password: boolean; active: boolean }>("staff", "user_id", uid);
  const [device, setDevice] = useState<{ status: "unknown" | "pending" | "approved" | "revoked"; needsName: boolean }>({ status: "unknown", needsName: !localStorage.getItem("tivbook.deviceName") });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (device.needsName || device.status === "approved") return;
    const id = localDeviceId();
    let stop = false;
    const check = async () => {
      try {
        const r = await call<{ status: "pending" | "approved" | "revoked" }>("requestDeviceApproval", {
          deviceId: id, name: localStorage.getItem("tivbook.deviceName") ?? "", platform: navigator.userAgent.slice(0, 40),
        });
        if (stop) return;
        if (r.status === "approved") setDeviceId(id);
        setDevice((d) => ({ ...d, status: r.status }));
      } catch (e) { setError((e as Error).message); }
    };
    void check();
    const timer = setInterval(check, 10_000);
    return () => { stop = true; clearInterval(timer); };
  }, [device.needsName, device.status]);

  if (staff.loading) return <div className="page center muted">{t("loading")}</div>;
  if (staff.data?.must_change_password) return <ChangePassword />;
  if (device.needsName) return <NameDevice onDone={() => setDevice((d) => ({ ...d, needsName: false }))} />;
  if (device.status !== "approved") {
    return (
      <div className="page stack" style={{ paddingTop: "15vh" }}>
        <div className="card stack center">
          <h1>{device.status === "revoked" ? "This computer has been revoked" : t("deviceWaiting")}</h1>
          <p className="muted">{t("deviceWaitingHint")}</p>
          <p className="small muted">{localStorage.getItem("tivbook.deviceName")} · {localDeviceId().slice(0, 12)}</p>
          {error && <div className="error">{error}</div>}
          <button className="secondary" onClick={signOut}>{t("signOut")}</button>
        </div>
      </div>
    );
  }
  return <Dashboard role={role} name={staff.data?.display_name ?? ""} />;
}

function NameDevice({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  return (
    <div className="page" style={{ paddingTop: "15vh" }}>
      <form className="card stack" onSubmit={(e) => { e.preventDefault(); localStorage.setItem("tivbook.deviceName", name.trim()); onDone(); }}>
        <label htmlFor="dn">{t("deviceName")}</label>
        <input id="dn" required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="block">{t("continue")}</button>
      </form>
    </div>
  );
}

function ChangePassword() {
  const { t } = useI18n();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setError("Passwords do not match.");
    const { error: e2 } = await supabase().auth.updateUser({ password: pw });
    if (e2) return setError(e2.message);
    try { await call("passwordChanged"); } catch (err) { setError((err as Error).message); }
  }
  return (
    <div className="page" style={{ paddingTop: "12vh" }}>
      <form className="card stack" onSubmit={submit}>
        <h1>{t("changePassword")}</h1>
        <div><label htmlFor="p1">{t("newPassword")}</label><input id="p1" type="password" minLength={10} required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        <div><label htmlFor="p2">{t("password")} (2)</label><input id="p2" type="password" minLength={10} required autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
        {error && <div className="error">{error}</div>}
        <button className="block">{t("save")}</button>
      </form>
    </div>
  );
}

/* ───────── Dashboard shell ───────── */

type Section = "players" | "codes" | "staff" | "devices" | "settings";
const SECTIONS: Array<{ id: Section; label: TKey; roles: Role[] }> = [
  { id: "players", label: "players", roles: ["super_admin", "manager", "tournament_director", "cashier", "floor_supervisor", "dealer", "front_desk"] },
  { id: "codes", label: "signInCodes", roles: ["super_admin", "manager", "cashier", "front_desk"] },
  { id: "staff", label: "staffAccounts", roles: ["super_admin", "manager"] },
  { id: "devices", label: "devices", roles: ["super_admin", "manager"] },
  { id: "settings", label: "settings", roles: ["super_admin", "manager"] },
];

function Dashboard({ role, name }: { role: Role; name: string }) {
  const { t, lang, setLang } = useI18n();
  const online = useOnline();
  const allowed = SECTIONS.filter((s) => s.roles.includes(role));
  const [section, setSection] = useState<Section>(allowed[0]!.id);
  return (
    <>
      <header className="topbar">
        <span className="brand">TI VEGAS · TiVBook</span>
        <div className="row small">
          <span title={online ? t("online") : t("offline")}><span className={`statusdot ${online ? "" : "off"}`} /> {online ? t("online") : "Offline"}</span>
          <span className="muted">{name} · {ROLE_LABEL[role][lang === "fr" ? 1 : 0]}</span>
          <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value as Lang)} style={{ width: "auto", minHeight: 36, padding: ".2rem .4rem" }}>
            <option value="en">EN</option><option value="fr">FR</option>
          </select>
          <button className="secondary" style={{ minHeight: 36, padding: ".3rem .7rem" }} onClick={signOut}>{t("signOut")}</button>
        </div>
      </header>
      {!online && <div className="notice small" style={{ borderRadius: 0 }}>{t("offline")}</div>}
      <nav className="row" style={{ padding: ".5rem 1rem", borderBottom: "1px solid var(--line)", gap: ".4rem" }}>
        {allowed.map((s) => (
          <button key={s.id} className={section === s.id ? "" : "secondary"} style={{ minHeight: 40 }} onClick={() => setSection(s.id)}>{t(s.label)}</button>
        ))}
      </nav>
      <main className="page wide">
        {section === "players" && <PlayersPage role={role} />}
        {section === "codes" && <DeskCodesPage />}
        {section === "staff" && <StaffPage role={role} />}
        {section === "devices" && <DevicesPage />}
        {section === "settings" && <SettingsPage role={role} />}
      </main>
    </>
  );
}
