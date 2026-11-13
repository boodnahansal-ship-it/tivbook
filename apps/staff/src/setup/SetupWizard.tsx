import { useState, type FormEvent } from "react";
import { encodeConnection, saveConnection, supabase } from "@tivbook/client";
import { installOnline, InstallError, REGIONS, STEPS } from "./install";
import { openExternal } from "../desktop";

/** First computer only: puts TiVBook online for the casino in one click. */
export function SetupWizard({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ token: "", region: "ap-south-1", casino: "Ti Vegas", name: "", email: "", pw: "", pw2: "" });
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(-1);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function start(e: FormEvent) {
    e.preventDefault();
    if (f.pw !== f.pw2) return setError("The two passwords are different.");
    setError(null);
    setRunning(true);
    try {
      const r = await installOnline(
        { accessToken: f.token, region: f.region, casinoName: f.casino, admin: { email: f.email.trim().toLowerCase(), password: f.pw, displayName: f.name.trim() || "Super Administrator" } },
        (s, d) => { setStep(s); setDetail(d ?? ""); },
      );
      const conn = { url: r.url, anonKey: r.anonKey, casino: f.casino };
      saveConnection(conn);
      setF((s) => ({ ...s, token: "" })); // forget the access token
      await supabase().auth.signInWithPassword({ email: f.email.trim().toLowerCase(), password: f.pw });
      setStep(STEPS.length);
      setCode(encodeConnection(conn));
    } catch (err) {
      setError(err instanceof InstallError ? err.message : `Unexpected problem: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  if (code) {
    return (
      <div className="page stack" style={{ paddingTop: "6vh" }}>
        <div className="ok"><strong>TiVBook is online for {f.casino}.</strong> You are signed in as the Super Administrator, and this computer is approved.</div>
        <div className="card stack">
          <h2>Connection code</h2>
          <p className="muted small">Other staff computers and the player app use this code once to connect. You can find it again any time in Settings.</p>
          <textarea readOnly rows={3} value={code} onFocus={(e) => e.target.select()} />
        </div>
        <button className="block" onClick={onDone}>Open TiVBook</button>
      </div>
    );
  }

  return (
    <div className="page stack" style={{ paddingTop: "4vh" }}>
      <h1>Set up TiVBook online</h1>
      <p className="muted">Do this once, on the first computer. It creates the casino's own free online database (Supabase, no bank card) and installs everything automatically.</p>
      <form className="stack" onSubmit={start}>
        <div className="card stack">
          <h2>1 · Supabase account (free)</h2>
          <ol className="small" style={{ margin: 0, paddingLeft: "1.2rem" }}>
            <li><button type="button" className="link" onClick={() => openExternal("https://supabase.com/dashboard/sign-up")}>Create a free account at supabase.com</button> (or sign in).</li>
            <li><button type="button" className="link" onClick={() => openExternal("https://supabase.com/dashboard/account/tokens")}>Open “Access Tokens”</button>, click <strong>Generate new token</strong>, name it “TiVBook”, copy it.</li>
            <li>Paste it here. It is used only during this setup and is not saved.</li>
          </ol>
          <div><label htmlFor="tk">Access token</label><input id="tk" required type="password" autoComplete="off" placeholder="sbp_…" value={f.token} onChange={set("token")} disabled={running} /></div>
          <div>
            <label htmlFor="rg">Server location</label>
            <select id="rg" value={f.region} onChange={set("region")} disabled={running}>{REGIONS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
          </div>
        </div>
        <div className="card stack">
          <h2>2 · Your administrator account</h2>
          <div className="grid2">
            <div><label htmlFor="cn">Casino name</label><input id="cn" required value={f.casino} onChange={set("casino")} disabled={running} /></div>
            <div><label htmlFor="an">Your name</label><input id="an" required value={f.name} onChange={set("name")} disabled={running} /></div>
            <div><label htmlFor="ae">Email</label><input id="ae" type="email" required value={f.email} onChange={set("email")} disabled={running} /></div>
            <div />
            <div><label htmlFor="p1">Password (min. 10 characters)</label><input id="p1" type="password" minLength={10} required autoComplete="new-password" value={f.pw} onChange={set("pw")} disabled={running} /></div>
            <div><label htmlFor="p2">Password again</label><input id="p2" type="password" minLength={10} required autoComplete="new-password" value={f.pw2} onChange={set("pw2")} disabled={running} /></div>
          </div>
        </div>
        {step >= 0 && (
          <div className="card stack">
            {STEPS.map((s, i) => (
              <div key={s} className="row" style={{ opacity: i > step ? 0.45 : 1 }}>
                <span style={{ width: "1.4rem" }}>{i < step ? "✓" : i === step ? (running ? "⏳" : error ? "✗" : "✓") : "·"}</span>
                <span>{s}{i === step && detail ? <span className="muted small"> — {detail}</span> : null}</span>
              </div>
            ))}
          </div>
        )}
        {error && <div className="error">{error}<div className="small" style={{ marginTop: ".4rem" }}>You can safely click the button again: setup continues where it stopped.</div></div>}
        <div className="row">
          <button disabled={running} style={{ flex: 1 }}>{running ? "Installing… keep this window open" : "Install TiVBook online"}</button>
          <button type="button" className="secondary" disabled={running} onClick={onCancel}>Back</button>
        </div>
      </form>
    </div>
  );
}
