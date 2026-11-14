import { useEffect, useMemo, useState } from "react";
import { DEFAULT_CALENDAR, openBookingDates, type BookingCalendarSettings } from "@tivbook/core/calendar";
import { instantToMuDate } from "@tivbook/core/time";
import { call, useI18n, useRows } from "@tivbook/client";

export interface TableDay { id: string; table_id: string; table_name: string; date: string; status: string; capacity: number; active_count: number; held_count: number; waiting_count: number; cutoff_at: string; open_time: string }
interface CashTable { table_id: string; game_type: string; small_blind_cents: number; big_blind_cents: number; min_buy_in_cents: number; max_buy_in_cents: number }
export interface Reservation { id: string; table_day_id: string; table_id: string; date: string; status: string; seat: number | null; cutoff_at: string }
export interface Waiting { id: string; table_day_id: string; status: string }

const ACTIVE = ["reserved", "checked_in", "seated"];
const muTime = (iso: string) => new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(11, 16);
const rs = (c: number) => `Rs ${(c / 100).toLocaleString("en-US")}`;
export const dayName = (d: string, lang: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { weekday: "short", day: "numeric", month: "short" });

/** Player: pick a day, see the tables and book a place (not a specific seat). */
export function CashGames({ playerId }: { playerId: string }) {
  const { t, lang } = useI18n();
  const cal = useRows<{ value: BookingCalendarSettings }>("settings", { column: "key", value: "booking_calendar" });
  const calendar = { ...DEFAULT_CALENDAR, ...(cal.rows[0]?.value ?? {}) };
  const today = instantToMuDate(Date.now());
  const dates = useMemo(() => openBookingDates(today, Date.now(), calendar), [today, JSON.stringify(calendar)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [date, setDate] = useState<string | null>(null);
  const current = date && dates.includes(date) ? date : dates[0] ?? today;

  const days = useRows<TableDay>("table_days", { column: "date", value: current }, { order: "table_name", ascending: true });
  const tables = useRows<CashTable>("cash_tables", null);
  const mine = useRows<Reservation>("cash_reservations", { column: "player_id", value: playerId });
  const waits = useRows<Waiting>("waiting_lists", { column: "player_id", value: playerId });
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const myWaiting = waits.rows.filter((w) => w.status === "waiting" || w.status === "offered");
  const waitKey = myWaiting.map((w) => w.id).join(",");
  useEffect(() => { if (waitKey) void call<{ positions: Record<string, number> }>("myWaitingPositions").then((r) => setPositions(r.positions)).catch(() => {}); }, [waitKey, days.rows]);

  const activeThatDay = mine.rows.find((r) => r.date === current && ACTIVE.includes(r.status));

  async function act(id: string, action: string, data: Record<string, unknown>, ok: string) {
    setBusy(id); setMsg(null);
    try { await call(action, data); setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(null); }
  }

  return (
    <div className="stack">
      <h1>{t("cashGames")}</h1>
      <div className="chips">
        {dates.map((d) => <button key={d} className={`chip ${d === current ? "on" : ""}`} onClick={() => setDate(d)}>{dayName(d, lang)}</button>)}
      </div>
      <p className="muted small">{t("bookingRules")} {t("bookingsOpen")} {calendar.openTime}.</p>
      {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
      {!days.loading && !days.rows.filter((d) => d.status === "open").length && <p className="muted">{t("noTables")}</p>}
      {days.rows.filter((d) => d.status === "open").map((d) => {
        const tb = tables.rows.find((x) => x.table_id === d.table_id);
        const left = Math.max(0, d.capacity - d.active_count - d.held_count);
        const past = Date.now() >= new Date(d.cutoff_at).getTime();
        const bookedHere = activeThatDay?.table_day_id === d.id ? activeThatDay : null;
        const w = myWaiting.find((x) => x.table_day_id === d.id);
        return (
          <div key={d.id} className="card stack">
            <div className="row spread">
              <div>
                <strong style={{ fontSize: "1.1rem" }}>{d.table_name}</strong>
                {tb && <div className="small muted">{tb.game_type} {tb.small_blind_cents / 100}/{tb.big_blind_cents / 100} · {t("buyIn")} {rs(tb.min_buy_in_cents)}–{rs(tb.max_buy_in_cents)}</div>}
                <div className="small muted">{t("starts")} {d.open_time} · {t("cutoff")} {muTime(d.cutoff_at)}</div>
              </div>
              <span className={`badge ${left > 0 ? "verified" : "unverified"}`}>{left > 0 ? `${left} ${t("placesLeft")}` : t("full")}</span>
            </div>
            <div className="meter"><i style={{ width: `${Math.min(100, ((d.capacity - left) / d.capacity) * 100)}%` }} /></div>
            {bookedHere ? (
              <div className="row spread">
                <span className="badge verified">✓ {t(`status_${bookedHere.status}` as "status_reserved")}{bookedHere.seat ? ` · ${bookedHere.seat}` : ""}</span>
                {bookedHere.status === "reserved" && (
                  <button className="secondary" disabled={busy === d.id} onClick={() => { if (confirm(t("confirmCancel"))) void act(d.id, "cancelCashReservation", { reservationId: bookedHere.id }, t("cancel") + " ✓"); }}>{t("cancelBooking")}</button>
                )}
              </div>
            ) : w ? (
              <div className="row spread">
                <span className="badge unverified">{t("onWaitingList")}{positions[w.id] ? ` · ${t("positionInQueue")} ${positions[w.id]}` : ""}</span>
                <button className="secondary" disabled={busy === d.id} onClick={() => void act(d.id, "leaveWaitingList", { waitingEntryId: w.id }, "✓")}>{t("leaveList")}</button>
              </div>
            ) : past ? null : left > 0 ? (
              <button className="block" disabled={!!activeThatDay || busy === d.id} onClick={() => void act(d.id, "reserveCashPlace", { tableDayId: d.id }, `${t("booked")} ✓ ${d.table_name}`)}>
                {activeThatDay ? t("booked") + ` · ${days.rows.find((x) => x.id === activeThatDay.table_day_id)?.table_name ?? ""}` : t("book")}
              </button>
            ) : (
              <button className="secondary block" disabled={!!activeThatDay || busy === d.id} onClick={() => void act(d.id, "joinWaitingList", { tableDayId: d.id }, t("onWaitingList") + " ✓")}>{t("joinWaitingList")}</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Player: upcoming bookings and waiting lists. */
export function MyBookings({ playerId }: { playerId: string }) {
  const { t, lang } = useI18n();
  const today = instantToMuDate(Date.now());
  const mine = useRows<Reservation>("cash_reservations", { column: "player_id", value: playerId }, { order: "date", ascending: true });
  const waits = useRows<Waiting & { player_id: string }>("waiting_lists", { column: "player_id", value: playerId });
  const upcoming = mine.rows.filter((r) => r.date >= today && ACTIVE.includes(r.status));
  const waiting = waits.rows.filter((w) => w.status === "waiting" || w.status === "offered");
  const dayIds = [...new Set([...upcoming.map((r) => r.table_day_id), ...waiting.map((w) => w.table_day_id)])];
  const [daysById, setDays] = useState<Record<string, TableDay>>({});
  const all = useRows<TableDay>("table_days", null, { enabled: dayIds.length > 0 });
  useEffect(() => { setDays(Object.fromEntries(all.rows.map((d) => [d.id, d]))); }, [all.rows]);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="stack">
      <h1>{t("myBookings")}</h1>
      {msg && <div className="error">{msg}</div>}
      {!upcoming.length && !waiting.length && <p className="muted">{t("noBookings")}</p>}
      {upcoming.map((r) => {
        const d = daysById[r.table_day_id];
        return (
          <div key={r.id} className="card row spread">
            <div>
              <strong>{d?.table_name ?? r.table_id}</strong>
              <div className="small muted">{dayName(r.date, lang)} · {t("cutoff")} {muTime(r.cutoff_at)}</div>
              <span className="badge verified">{t(`status_${r.status}` as "status_reserved")}{r.seat ? ` · ${r.seat}` : ""}</span>
            </div>
            {r.status === "reserved" && <button className="secondary" onClick={() => { if (confirm(t("confirmCancel"))) call("cancelCashReservation", { reservationId: r.id }).catch((e) => setMsg((e as Error).message)); }}>{t("cancel")}</button>}
          </div>
        );
      })}
      {waiting.map((w) => {
        const d = daysById[w.table_day_id];
        return (
          <div key={w.id} className="card row spread">
            <div><strong>{d?.table_name ?? ""}</strong><div className="small muted">{d ? dayName(d.date, lang) : ""}</div><span className="badge unverified">{t("onWaitingList")}</span></div>
            <button className="secondary" onClick={() => call("leaveWaitingList", { waitingEntryId: w.id }).catch((e) => setMsg((e as Error).message))}>{t("leaveList")}</button>
          </div>
        );
      })}
    </div>
  );
}
