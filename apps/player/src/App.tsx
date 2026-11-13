import { useState, type FormEvent } from "react";
import { call, ConnectScreen, getConnection, IdPhotos, refreshSession, RegistrationForm, supabase, useI18n, useOnline, useRow, useSession, type Lang } from "@tivbook/client";

interface PlayerRow {
  surname: string; first_names: string; phone_e164: string; kyc_status: "unverified" | "verified" | "rejected";
  id_doc_type: "national_id" | "passport"; id_images: string[]; date_of_birth: string; nationality: string;
}

export function App() {
  const [connected, setConnected] = useState(!!getConnection());
  if (!connected) return <ConnectScreen onConnected={() => setConnected(true)} />;
  return <Connected />;
}

function Connected() {
  const s = useSession();
  const { t } = useI18n();
  if (!s.ready) return <Splash text={t("loading")} />;
  if (!s.user) return <Shell><SignIn /></Shell>;
  const playerId = s.claims.player_id as string | undefined;
  if (!playerId) {
    return (
      <Shell>
        <div className="card stack">
          <h1>{t("register")}</h1>
          <RegistrationForm verifiedPhone={s.claims.phone_e164 as string} onRegistered={() => void refreshSession()} />
        </div>
      </Shell>
    );
  }
  return <PlayerHome playerId={playerId} />;
}

function Splash({ text }: { text: string }) {
  return <div className="page center" style={{ paddingTop: "30vh" }}><div className="brand" style={{ fontSize: "2rem" }}>TiVBook</div><p className="muted">{text}</p></div>;
}

function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value as Lang)} style={{ width: "auto", minHeight: 40, padding: ".3rem .5rem" }}>
      <option value="en">EN</option>
      <option value="fr">FR</option>
    </select>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const online = useOnline();
  const { t } = useI18n();
  return (
    <>
      <header className="topbar">
        <span className="brand">TI VEGAS · TiVBook</span>
        <LangSwitch />
      </header>
      {!online && <div className="notice small" style={{ borderRadius: 0 }}>{t("offline")}</div>}
      <main className="page">{children}</main>
    </>
  );
}

/* ───────── WhatsApp sign-in ───────── */

function SignIn() {
  const { t } = useI18n();
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [atDesk, setAtDesk] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await call<{ phone: string; delivery: "whatsapp" | "desk" }>("requestOtp", { phone: sentTo ?? phone });
      setSentTo(r.phone);
      setAtDesk(r.delivery === "desk");
      setCode("");
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await call<{ email: string; password: string }>("verifyOtpCode", { phone: sentTo, code });
      const { error: e2 } = await supabase().auth.signInWithPassword({ email: r.email, password: r.password });
      if (e2) throw e2;
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <div className="stack" style={{ marginTop: "8vh" }}>
      <div className="center"><div className="brand" style={{ fontSize: "2.2rem" }}>TiVBook</div><p className="muted">{t("welcome")}</p></div>
      {!sentTo ? (
        <form className="card stack" onSubmit={send}>
          <div>
            <label htmlFor="phone">{t("mobileNumber")}</label>
            <input id="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="5712 3456" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <p className="muted small" style={{ marginTop: ".4rem" }}>{t("mobileHint")}</p>
          </div>
          {error && <div className="error">{error}</div>}
          <button className="block" disabled={busy}>{busy ? t("loading") : t("sendCode")}</button>
        </form>
      ) : (
        <form className="card stack" onSubmit={verify}>
          {atDesk
            ? <div className="notice">{t("codeAtDesk")}<div style={{ marginTop: ".4rem" }}>{t("codeForNumber")} <strong>{sentTo}</strong></div></div>
            : <p>{t("codeSentTo")} <strong>{sentTo}</strong></p>}
          <div>
            <label htmlFor="code">{t("enterCode")}</label>
            <input id="code" className="code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="block" disabled={busy || code.length !== 6}>{busy ? t("loading") : t("verify")}</button>
          <div className="row spread">
            <button type="button" className="link" onClick={() => { setSentTo(null); setError(null); }}>{t("changeNumber")}</button>
            <button type="button" className="link" disabled={busy} onClick={() => void send()}>{t("resend")}</button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ───────── Home & profile ───────── */

function PlayerHome({ playerId }: { playerId: string }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"home" | "profile">("home");
  const { data: p, loading } = useRow<PlayerRow>("players", "player_id", playerId);
  if (loading || !p) return <Splash text={t("loading")} />;
  const required = p.id_doc_type === "passport" ? ["passport"] : ["id_front", "id_back"];
  const missingPhotos = required.some((k) => !p.id_images?.includes(k));

  return (
    <Shell>
      {tab === "home" ? (
        <div className="stack">
          <p className="muted">{t("welcome")}, <strong style={{ color: "var(--text)" }}>{p.first_names}</strong></p>
          <div className="card center">
            <div className="muted small">{t("yourPlayerId")}</div>
            <div className="player-id">{playerId}</div>
            <div className="muted small">{t("showAtCashier")}</div>
          </div>
          <div className="card row spread">
            <strong>{t("identity")}</strong>
            <span className={`badge ${p.kyc_status}`}>{t(`kyc_${p.kyc_status}`)}</span>
          </div>
          {missingPhotos && p.kyc_status !== "verified" && (
            <div className="card stack">
              <h2>{t("idPhotos")}</h2>
              <IdPhotos docType={p.id_doc_type} uploaded={p.id_images ?? []} />
            </div>
          )}
        </div>
      ) : (
        <div className="stack">
          <div className="card stack">
            <h2>{t("profile")}</h2>
            <Field k={t("surname")} v={p.surname} />
            <Field k={t("firstNames")} v={p.first_names} />
            <Field k={t("mobileNumber")} v={p.phone_e164} />
            <Field k={t("dateOfBirth")} v={p.date_of_birth} />
            <Field k={t("nationality")} v={p.nationality} />
          </div>
          <div className="card row spread"><span>{t("language")}</span><LangSwitch /></div>
          <button className="secondary block" onClick={() => void supabase().auth.signOut()}>{t("signOut")}</button>
        </div>
      )}
      <nav className="tabbar">
        <button className={tab === "home" ? "on" : ""} onClick={() => setTab("home")}><span aria-hidden>🏠</span>{t("home")}</button>
        <button className={tab === "profile" ? "on" : ""} onClick={() => setTab("profile")}><span aria-hidden>👤</span>{t("profile")}</button>
      </nav>
    </Shell>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return <div className="row spread"><span className="muted">{k}</span><span>{v}</span></div>;
}
