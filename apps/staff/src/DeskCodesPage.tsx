import { useEffect, useState } from "react";
import { call, useI18n } from "@tivbook/client";

interface DeskCode { phone: string; code: string; expiresAt: number; attemptsLeft: number; player: { id: string; name: string } | null }

/** Free sign-in without WhatsApp: the cashier reads the player's code to them in person. */
export function DeskCodesPage() {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [codes, setCodes] = useState<DeskCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await call<{ codes: DeskCode[] }>("listDeskCodes", { query: q });
        if (!stop) { setCodes(r.codes); setError(null); }
      } catch (e) { if (!stop) setError((e as Error).message); }
    };
    void load();
    const refresh = setInterval(load, 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; clearInterval(refresh); clearInterval(clock); };
  }, [q]);

  const left = (ms: number) => {
    const s = Math.max(0, Math.round((ms - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>{t("signInCodes")}</h1>
      <p className="muted">{t("signInCodesHint")}</p>
      <input inputMode="tel" placeholder={t("mobileNumber")} value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="error">{error}</div>}
      {codes.length === 0 && !error && <p className="muted">{t("noCodes")}</p>}
      {codes.map((c) => (
        <div key={c.phone} className="card row spread">
          <div>
            <div><strong>{c.phone}</strong></div>
            <div className="small muted">{c.player ? `${c.player.id} · ${c.player.name}` : t("newPlayer")} · {t("expiresIn")} {left(c.expiresAt)}</div>
          </div>
          <div className="player-id" style={{ fontSize: "2.2rem", letterSpacing: ".25em" }}>{c.code}</div>
        </div>
      ))}
    </div>
  );
}
