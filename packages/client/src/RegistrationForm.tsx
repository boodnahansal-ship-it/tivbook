import { useState, type FormEvent } from "react";
import { call } from "./firebase";
import { useI18n } from "./i18n";

export interface RegistrationFormProps {
  /** Pre-filled and locked for self-registration (the verified WhatsApp number). */
  verifiedPhone?: string;
  onRegistered: (playerId: string) => void;
}

const today = new Date().toISOString().slice(0, 10);

/** Same form for the player app (self-registration) and the staff software (front desk / cashier). */
export function RegistrationForm({ verifiedPhone, onRegistered }: RegistrationFormProps) {
  const { t, lang } = useI18n();
  const [f, setF] = useState({
    surname: "", firstNames: "", dateOfBirth: "", phone: verifiedPhone ?? "", address: "",
    countryOfResidence: "Mauritius", nationality: "Mauritian", idDocType: "national_id", idDocNumber: "", acceptedTerms: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? !!e.target.checked : e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ playerId: string }>("registerPlayer", { ...f, language: lang });
      onRegistered(r.playerId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <p className="notice small">{t("namesMustMatch")}</p>
      <div className="grid2">
        <div><label htmlFor="sn">{t("surname")}</label><input id="sn" required autoComplete="family-name" value={f.surname} onChange={set("surname")} style={{ textTransform: "uppercase" }} /></div>
        <div><label htmlFor="fn">{t("firstNames")}</label><input id="fn" required autoComplete="given-name" value={f.firstNames} onChange={set("firstNames")} /></div>
        <div><label htmlFor="dob">{t("dateOfBirth")}</label><input id="dob" type="date" required max={today} value={f.dateOfBirth} onChange={set("dateOfBirth")} /></div>
        <div>
          <label htmlFor="ph">{t("mobileNumber")}</label>
          <input id="ph" type="tel" required inputMode="tel" value={f.phone} onChange={set("phone")} readOnly={!!verifiedPhone} placeholder="+230 5…" />
        </div>
      </div>
      <div><label htmlFor="ad">{t("address")}</label><input id="ad" required autoComplete="street-address" value={f.address} onChange={set("address")} /></div>
      <div className="grid2">
        <div><label htmlFor="cr">{t("countryOfResidence")}</label><input id="cr" required value={f.countryOfResidence} onChange={set("countryOfResidence")} /></div>
        <div><label htmlFor="na">{t("nationality")}</label><input id="na" required value={f.nationality} onChange={set("nationality")} /></div>
        <div>
          <label htmlFor="dt">{t("idDocType")}</label>
          <select id="dt" value={f.idDocType} onChange={set("idDocType")}>
            <option value="national_id">{t("nationalId")}</option>
            <option value="passport">{t("passport")}</option>
          </select>
        </div>
        <div><label htmlFor="dn">{t("idDocNumber")}</label><input id="dn" required value={f.idDocNumber} onChange={set("idDocNumber")} style={{ textTransform: "uppercase" }} /></div>
      </div>
      <label className="check"><input type="checkbox" required checked={f.acceptedTerms} onChange={set("acceptedTerms")} />{t("acceptTerms")}</label>
      {error && <div className="error">{error}</div>}
      <button className="block" disabled={busy}>{busy ? t("loading") : t("register")}</button>
    </form>
  );
}
