import { useEffect, useRef, useState } from "react";
import { call, supabase, useI18n, useRows } from "@tivbook/client";

interface Offer { id: string; table_day_id: string; status: string; expires_at: string; list_type: string }

/**
 * Full-screen "PLACE AVAILABLE" alarm. Appears instantly (live update) when the server
 * offers this player a place, with sound, vibration and a countdown to the server deadline.
 * When the phone is locked, the push notification (if set up) wakes the player instead.
 */
export function OfferAlarm({ playerId }: { playerId: string }) {
  const { t } = useI18n();
  const offers = useRows<Offer>("waiting_offers", { column: "player_id", value: playerId }, { order: "created_at" });
  const [now, setNow] = useState(Date.now());
  const offer = offers.rows.find((o) => o.status === "pending" && new Date(o.expires_at).getTime() > now) ?? null;
  const [table, setTable] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!offer) return;
    void supabase().from("table_days").select("table_name").eq("id", offer.table_day_id).single().then(({ data }) => setTable((data as { table_name: string } | null)?.table_name ?? ""));
  }, [offer?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useAlarmSound(!!offer);

  if (!offer) return null;
  const left = Math.max(0, Math.round((new Date(offer.expires_at).getTime() - now) / 1000));
  async function respond(action: "accept" | "decline") {
    setBusy(true); setError(null);
    try { await call("respondPlaceOffer", { offerId: offer!.id, action }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="offer-overlay" role="alertdialog" aria-live="assertive">
      <div className="offer-box stack">
        <div className="brand pulse" style={{ fontSize: "1.35rem" }}>{t("placeAvailable")}</div>
        <p>{t("placeAvailableText")} <strong>{table}</strong>.</p>
        <div className="countdown">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</div>
        {error && <div className="error">{error}</div>}
        <button className="block" disabled={busy} onClick={() => void respond("accept")}>✓ {t("acceptPlace")}</button>
        <button className="secondary block" disabled={busy} onClick={() => void respond("decline")}>{t("decline")}</button>
      </div>
    </div>
  );
}

/** Original TiVBook alarm: repeating two-tone chime + vibration while an offer is open. */
export function useAlarmSound(on: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!on) return;
    let stop = false;
    const ring = () => {
      if (stop) return;
      try {
        ctxRef.current ??= new AudioContext();
        playChime(ctxRef.current);
      } catch { /* audio unavailable */ }
      navigator.vibrate?.([400, 150, 400]);
    };
    ring();
    const timer = setInterval(ring, 2500);
    return () => { stop = true; clearInterval(timer); navigator.vibrate?.(0); };
  }, [on]);
}

export function playChime(ctx: AudioContext) {
  void ctx.resume();
  const notes = [880, 1318.5, 880, 1318.5];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = f;
    const t0 = ctx.currentTime + i * 0.22;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.5, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + 0.21);
  });
}
