import { useEffect, useRef, useState, type FormEvent } from "react";
import { decodeConnection, saveConnection, type Connection } from "./connection";
import { useI18n } from "./i18n";

declare class BarcodeDetector {
  constructor(o: { formats: string[] });
  detect(src: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}

/** Paste or scan the casino's connection code once; it is remembered on this device. */
export function ConnectScreen({ onConnected, extra }: { onConnected: (c: Connection) => void; extra?: React.ReactNode }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const canScan = typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices;

  // A connection link like …#TVB1-xxxx connects straight away.
  useEffect(() => {
    const fromUrl = decodeConnection(window.location.hash + window.location.search);
    if (fromUrl) accept(fromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function accept(c: Connection) {
    saveConnection(c);
    onConnected(c);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const c = decodeConnection(code);
    if (!c) return setError(t("invalidCode"));
    accept(c);
  }

  return (
    <div className="page" style={{ paddingTop: "10vh" }}>
      <div className="stack">
        <div className="center"><div className="brand" style={{ fontSize: "2.2rem" }}>TiVBook</div><p className="muted">Ti Vegas</p></div>
        {extra}
        <form className="card stack" onSubmit={submit}>
          <h2>{t("connectTitle")}</h2>
          <p className="muted small">{t("connectHint")}</p>
          <div>
            <label htmlFor="cc">{t("connectionCode")}</label>
            <textarea id="cc" rows={3} value={code} onChange={(e) => setCode(e.target.value)} placeholder="TVB1-…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="block">{t("connect")}</button>
          {canScan && !scanning && <button type="button" className="secondary block" onClick={() => setScanning(true)}>📷 {t("scanQr")}</button>}
          {scanning && <Scanner onCode={(v) => { const c = decodeConnection(v); if (c) accept(c); else setError(t("invalidCode")); setScanning(false); }} onClose={() => setScanning(false)} />}
        </form>
      </div>
    </div>
  );
}

function Scanner({ onCode, onClose }: { onCode: (v: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    (async () => {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (!video.current) return;
      video.current.srcObject = stream;
      await video.current.play();
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      while (!stop) {
        const found = await detector.detect(video.current).catch(() => []);
        if (found[0]) { onCode(found[0].rawValue); break; }
        await new Promise((r) => setTimeout(r, 300));
      }
    })().catch(onClose);
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode, onClose]);
  return <video ref={video} playsInline muted style={{ width: "100%", borderRadius: 10 }} />;
}
