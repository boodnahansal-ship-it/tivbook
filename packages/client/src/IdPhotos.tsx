import { useState } from "react";
import { call } from "./api";
import { useI18n, type TKey } from "./i18n";
import { prepareIdImage } from "./images";

type Kind = "id_front" | "id_back" | "passport";

/**
 * Capture/upload of ID document photos. On phones, `capture` opens the camera;
 * on PCs it opens a file picker (or a document scanner's saved image).
 */
export function IdPhotos(props: {
  docType: "national_id" | "passport";
  uploaded: string[];
  /** Staff uploading for a player; omitted when the player uploads their own. */
  playerId?: string;
  onDone?: () => void;
}) {
  const { t } = useI18n();
  const kinds: Kind[] = props.docType === "passport" ? ["passport"] : ["id_front", "id_back"];
  const [previews, setPreviews] = useState<Partial<Record<Kind, string>>>({});
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = (k: Kind): TKey => (k === "passport" ? "passportPage" : k);

  async function pick(kind: Kind, file: File | undefined) {
    if (!file) return;
    setBusy(kind);
    setError(null);
    try {
      const img = await prepareIdImage(file);
      await call("uploadIdDocument", { kind, base64: img.base64, ...(props.playerId ? { playerId: props.playerId } : {}) });
      setPreviews((p) => ({ ...p, [kind]: img.previewUrl || "uploaded" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const complete = kinds.every((k) => props.uploaded.includes(k) || previews[k]);

  return (
    <div className="stack">
      <p className="muted small">{t("idPhotosHint")}</p>
      <div className="grid2">
        {kinds.map((k) => {
          const done = props.uploaded.includes(k) || previews[k];
          const src = previews[k] && previews[k] !== "uploaded" ? previews[k] : null;
          return (
            <div key={k} className="card stack">
              <div className="row spread"><strong>{t(label(k))}</strong>{done && <span className="badge verified">{t("uploaded")}</span>}</div>
              {src ? <img className="photo" src={src} alt={t(label(k))} /> : <div className="photo">{busy === k ? t("uploading") : "🪪"}</div>}
              <label className="btn" style={{ color: "var(--gold-ink)", margin: 0, opacity: busy ? 0.5 : 1 }}>
                {done ? t("replace") : t("takePhoto")}
                <input type="file" accept="image/jpeg,image/png,image/heic,image/heif" capture="environment" hidden disabled={!!busy}
                  onChange={(e) => { void pick(k, e.target.files?.[0]); e.target.value = ""; }} />
              </label>
            </div>
          );
        })}
      </div>
      {error && <div className="error">{error}</div>}
      {props.onDone && <button className="block" disabled={!complete || !!busy} onClick={props.onDone}>{t("done")}</button>}
    </div>
  );
}
