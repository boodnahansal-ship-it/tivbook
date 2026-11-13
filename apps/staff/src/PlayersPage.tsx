import { useEffect, useState, type FormEvent } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { call, db, IdPhotos, RegistrationForm, useDoc, useI18n } from "@tivbook/client";
import { can, type Role } from "./roles";

interface Hit { playerId: string; surname: string; firstNames: string; phoneE164: string; kycStatus: string; status: string }
interface PlayerDoc {
  surname: string; firstNames: string; phoneE164: string; dateOfBirth: string; address: string; countryOfResidence: string;
  nationality: string; idDocType: "national_id" | "passport"; idImages: string[]; kycStatus: "unverified" | "verified" | "rejected";
  kycReason?: string; status: string; source?: string;
}
interface IdDoc { id: string; kind: string; contentType: string }

export function PlayersPage({ role }: { role: Role }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setHits((await call<{ players: Hit[] }>("searchPlayers", { query: q })).players); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (registering) {
    return (
      <div className="card stack" style={{ maxWidth: 720 }}>
        <div className="row spread"><h1>{t("registerPlayer")}</h1><button className="secondary" onClick={() => setRegistering(false)}>{t("cancel")}</button></div>
        <RegistrationForm onRegistered={(id) => { setRegistering(false); setOpen(id); }} />
      </div>
    );
  }
  if (open) return <PlayerCard playerId={open} role={role} onBack={() => setOpen(null)} />;

  return (
    <div className="stack">
      <form className="row" onSubmit={search}>
        <input style={{ flex: "1 1 260px" }} autoFocus placeholder={t("searchHint")} value={q} onChange={(e) => setQ(e.target.value)} required />
        <button disabled={busy}>{t("search")}</button>
        {can.register(role) && <button type="button" className="secondary" onClick={() => setRegistering(true)}>+ {t("registerPlayer")}</button>}
      </form>
      {error && <div className="error">{error}</div>}
      {hits && (hits.length === 0 ? <p className="muted">{t("noResults")}</p> : (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>ID</th><th>{t("surname")}</th><th>{t("firstNames")}</th><th>{t("mobileNumber")}</th><th>{t("identity")}</th></tr></thead>
            <tbody>
              {hits.map((h) => (
                <tr key={h.playerId} className="clickable" onClick={() => setOpen(h.playerId)}>
                  <td><strong>{h.playerId}</strong></td><td>{h.surname}</td><td>{h.firstNames}</td><td>{h.phoneE164}</td>
                  <td><span className={`badge ${h.kycStatus}`}>{h.kycStatus}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/** Live player card: any change (player app upload, another cashier) appears immediately. */
function PlayerCard({ playerId, role, onBack }: { playerId: string; role: Role; onBack: () => void }) {
  const { t } = useI18n();
  const { data: p, loading } = useDoc<PlayerDoc>(`players/${playerId}`);
  const [docs, setDocs] = useState<IdDoc[]>([]);
  const [image, setImage] = useState<{ src: string; kind: string; heic: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!can.viewId(role) && !can.register(role)) return;
    return onSnapshot(query(collection(db, "identity_documents"), where("playerId", "==", playerId), where("replacedBy", "==", null)),
      (s) => setDocs(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<IdDoc, "id">) }))));
  }, [playerId, role]);

  async function view(id: string) {
    try {
      const r = await call<{ contentType: string; base64: string; kind: string }>("getIdDocumentImage", { documentId: id });
      setImage({ src: `data:${r.contentType};base64,${r.base64}`, kind: r.kind, heic: r.contentType === "image/heic" });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  async function kyc(status: "verified" | "rejected") {
    setMsg(null);
    try { await call("setKycStatus", { playerId, status, reason: reason || undefined }); setMsg({ ok: true, text: status === "verified" ? t("kyc_verified") : t("rejectIdentity") }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }

  if (loading) return <p className="muted">{t("loading")}</p>;
  if (!p) return <div className="stack"><button className="secondary" onClick={onBack}>{t("back")}</button><p>{t("noResults")}</p></div>;

  return (
    <div className="stack">
      <div className="row spread">
        <button className="secondary" onClick={onBack}>← {t("back")}</button>
        <button className="secondary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="grid2">
        <div className="card stack">
          <div className="row spread"><h1 style={{ margin: 0 }}>{p.surname} {p.firstNames}</h1><span className="player-id" style={{ fontSize: "2rem" }}>{playerId}</span></div>
          <Row k={t("mobileNumber")} v={p.phoneE164} />
          <Row k={t("dateOfBirth")} v={p.dateOfBirth} />
          <Row k={t("address")} v={p.address} />
          <Row k={t("countryOfResidence")} v={p.countryOfResidence} />
          <Row k={t("nationality")} v={p.nationality} />
          <Row k={t("idDocType")} v={p.idDocType === "passport" ? t("passport") : t("nationalId")} />
          <div className="row spread"><span className="muted">{t("identity")}</span><span className={`badge ${p.kycStatus}`}>{t(`kyc_${p.kycStatus}`)}</span></div>
          {p.kycReason && <p className="small muted">{t("reason")}: {p.kycReason}</p>}
        </div>
        <div className="card stack">
          <h2>{t("idPhotos")}</h2>
          {can.viewId(role) && docs.length > 0 && (
            <div className="row">{docs.map((d) => <button key={d.id} className="secondary" onClick={() => void view(d.id)}>{t("viewPhoto")}: {d.kind}</button>)}</div>
          )}
          {can.register(role) && <IdPhotos docType={p.idDocType} uploaded={p.idImages ?? []} playerId={playerId} />}
          {can.verifyKyc(role) && p.kycStatus !== "verified" && (
            <div className="stack">
              <p className="small muted">Check the ORIGINAL document in hand: photo, names, date of birth and number.</p>
              <button onClick={() => void kyc("verified")}>✓ {t("verifyIdentity")}</button>
              <div className="row">
                <input style={{ flex: 1 }} placeholder={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="danger" disabled={!reason} onClick={() => void kyc("rejected")}>{t("rejectIdentity")}</button>
              </div>
            </div>
          )}
          {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
        </div>
      </div>
      {image && (
        <div role="dialog" onClick={() => setImage(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem", zIndex: 20 }}>
          {image.heic
            ? <div className="card stack center"><p>HEIC photo — this computer cannot display it.</p><a className="btn" href={image.src} download={`${playerId}-${image.kind}.heic`}>Download</a></div>
            : <img src={image.src} alt={image.kind} style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }} />}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="row spread"><span className="muted">{k}</span><span style={{ textAlign: "right" }}>{v || "—"}</span></div>;
}
