import { useEffect, useMemo, useState, type FormEvent } from "react";
import { addDays, instantToMuDate } from "@tivbook/core/time";
import { call, useI18n, useRows } from "@tivbook/client";
import { playerNames } from "./TablesPage";

interface TableDay { id: string; table_id: string; table_name: string; date: string; status: "open" | "closed"; capacity: number; active_count: number; held_count: number; waiting_count: number; cutoff_at: string; open_time: string }
interface Reservation { id: string; player_id: string; status: string; seat: number | null; source: string; created_at: string }
interface Waiting { id: string; player_id: string; status: string; requested_at: string; list_type: string; current_offer_id: string | null }
interface Offer { id: string; player_id: string; status: string; expires_at: string; waiting_entry_id: string }

const dayLabel = (d: string, i: number) => (i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }));
const muTime = (iso: string) => new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(11, 16);

/** Floor: live view of each table — bookings, check-in, seats, waiting list and alarms. */
export function FloorPage() {
  const today = instantToMuDate(Date.now());
  const dates = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(today, i)), [today]);
  const [date, setDate] = useState(today);
  const { rows: days } = useRows<TableDay>("table_days", { column: "date", value: date }, { order: "table_name", ascending: true });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = days.find((d) => d.id === openId) ?? null;

  return (
    <div className="stack">
      <div className="chips">
        {dates.map((d, i) => <button key={d} className={`chip ${d === date ? "on" : ""}`} onClick={() => { setDate(d); setOpenId(null); }}>{dayLabel(d, i)}</button>)}
      </div>
      {!days.length && <p className="muted">No tables on this day. Create tables in “Tables”.</p>}
      <div className="grid3">
        {days.map((d) => {
          const used = d.active_count + d.held_count;
          return (
            <button key={d.id} className={`tablecard ${d.id === openId ? "on" : ""}`} onClick={() => setOpenId(d.id)}>
              <div className="row spread"><strong>{d.table_name}</strong>{d.status === "closed" ? <span className="badge rejected">closed</span> : <span className="small muted">{d.open_time}</span>}</div>
              <div className="meter"><i style={{ width: `${Math.min(100, (used / d.capacity) * 100)}%` }} /></div>
              <div className="small">{d.active_count}/{d.capacity} booked{d.held_count ? ` · ${d.held_count} offered` : ""}{d.waiting_count ? ` · ${d.waiting_count} waiting` : ""}</div>
            </button>
          );
        })}
      </div>
      {open && <TableView day={open} />}
    </div>
  );
}

function TableView({ day }: { day: TableDay }) {
  const { t } = useI18n();
  const res = useRows<Reservation>("cash_reservations", { column: "table_day_id", value: day.id }, { order: "created_at", ascending: true });
  const wl = useRows<Waiting>("waiting_lists", { column: "table_day_id", value: day.id }, { order: "requested_at", ascending: true });
  const offers = useRows<Offer>("waiting_offers", { column: "table_day_id", value: day.id }, { order: "created_at", ascending: false });
  const active = res.rows.filter((r) => ["reserved", "checked_in", "seated"].includes(r.status));
  const waiting = wl.rows.filter((w) => w.status === "waiting" || w.status === "offered");
  const pending = offers.rows.filter((o) => o.status === "pending");
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);

  const ids = [...new Set([...active.map((r) => r.player_id), ...waiting.map((w) => w.player_id)])].sort().join(",");
  useEffect(() => { void playerNames(ids ? ids.split(",") : []).then(setNames); }, [ids]);

  async function act(action: string, data: Record<string, unknown>, ok?: string) {
    setMsg(null);
    try { await call(action, data); if (ok) setMsg({ ok: true, text: ok }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  const who = (id: string) => `${id} · ${names[id] ?? ""}`;
  const seats = Array.from({ length: day.capacity }, (_, i) => i + 1);
  const bySeat = new Map(active.filter((r) => r.status === "seated" && r.seat).map((r) => [r.seat!, r]));
  const free = day.capacity - day.active_count - day.held_count;

  return (
    <div className="card stack">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>{day.table_name} · {day.date}</h2>
        <div className="row">
          <span className="small muted">Arrive by {muTime(day.cutoff_at)}</span>
          <button className="secondary" onClick={() => void act("setTableDay", { tableDayId: day.id, capacity: day.capacity - 1 })} disabled={day.capacity <= 2}>− seat</button>
          <button className="secondary" onClick={() => void act("setTableDay", { tableDayId: day.id, capacity: day.capacity + 1 })} disabled={day.capacity >= 12}>+ seat</button>
          <button className={day.status === "open" ? "danger" : ""} onClick={() => void act("setTableDay", { tableDayId: day.id, status: day.status === "open" ? "closed" : "open" })}>{day.status === "open" ? "Close table" : "Open table"}</button>
        </div>
      </div>

      <SeatDiagram seats={seats} bySeat={bySeat} names={names} selecting={!!selected}
        onSeat={(n) => { if (selected) { void act("seatPlayer", { reservationId: selected, seat: n }); setSelected(null); } }} />
      {selected && <div className="notice small">Click a free seat for {who(active.find((r) => r.id === selected)?.player_id ?? "")}. <button className="link" onClick={() => setSelected(null)}>Cancel</button></div>}

      <div className="grid2">
        <div className="stack">
          <h3>Bookings ({active.length}/{day.capacity}) · {free > 0 ? `${free} free` : "full"}</h3>
          {active.map((r) => (
            <div key={r.id} className="row spread" style={{ borderBottom: "1px solid var(--line)", paddingBottom: ".4rem" }}>
              <div><strong>{who(r.player_id)}</strong><div className="small muted">{t(`status_${r.status}` as "status_reserved")}{r.seat ? ` · seat ${r.seat}` : ""}</div></div>
              <div className="row">
                {r.status === "reserved" && <button className="secondary" onClick={() => void act("checkInReservation", { reservationId: r.id })}>Arrived</button>}
                <button className="secondary" onClick={() => setSelected(r.id)}>{r.seat ? "Move" : "Seat"}</button>
                <button className="secondary" onClick={() => void act("leaveTable", { reservationId: r.id, noShow: r.status === "reserved" }, "Place released — next player alerted.")}>{r.status === "reserved" ? "No-show" : "Left"}</button>
              </div>
            </div>
          ))}
          <AddPlayer tableDayId={day.id} full={free <= 0} onMsg={setMsg} />
        </div>
        <div className="stack">
          <h3>Waiting list ({waiting.length})</h3>
          {waiting.map((w, i) => {
            const o = pending.find((x) => x.waiting_entry_id === w.id);
            const left = o ? Math.max(0, Math.round((new Date(o.expires_at).getTime() - now) / 1000)) : 0;
            return (
              <div key={w.id} className="row spread" style={{ borderBottom: "1px solid var(--line)", paddingBottom: ".4rem" }}>
                <div><strong>{i + 1}. {who(w.player_id)}</strong>
                  <div className="small muted">{o ? <span style={{ color: "var(--gold)" }}>🔔 place offered · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left</span> : `waiting since ${muTime(w.requested_at)}`}</div>
                </div>
                <button className="secondary" onClick={() => void act("leaveWaitingList", { waitingEntryId: w.id })}>Remove</button>
              </div>
            );
          })}
          {!waiting.length && <p className="muted small">Nobody waiting.</p>}
          {free > 0 && waiting.length > 0 && !pending.length && (
            <button onClick={() => void act("notifyPlaceReleased", { tableDayId: day.id }, "Next player alerted.")}>🔔 Offer free place to next player</button>
          )}
        </div>
      </div>
      {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
    </div>
  );
}

/** Oval poker table with numbered seats; players don't book seats, the floor assigns them on arrival. */
function SeatDiagram({ seats, bySeat, names, selecting, onSeat }: { seats: number[]; bySeat: Map<number, Reservation>; names: Record<string, string>; selecting: boolean; onSeat: (n: number) => void }) {
  const W = 560, H = 315, cx = W / 2, cy = H / 2, rx = 220, ry = 105;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="felt" role="img" aria-label="Seating diagram">
      <ellipse cx={cx} cy={cy} rx={rx - 25} ry={ry - 18} fill="#14532d" stroke="#d6b25e" strokeWidth="6" />
      <text x={cx} y={cy + 5} textAnchor="middle" fill="#d6b25e" fontSize="16" fontWeight="700">TI VEGAS</text>
      {seats.map((n, i) => {
        const a = (i / seats.length) * Math.PI * 2 + Math.PI / 2;
        const x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * (ry + 25);
        const r = bySeat.get(n);
        const name = r ? (names[r.player_id] ?? r.player_id).split(" ")[0] : "";
        const clickable = selecting && !r;
        return (
          <g key={n} onClick={() => clickable && onSeat(n)} style={{ cursor: clickable ? "pointer" : "default" }}>
            <circle cx={x} cy={y} r="27" fill={r ? "#d6b25e" : clickable ? "#2f6f46" : "#20242d"} stroke={clickable ? "#d6b25e" : "#2c313c"} strokeWidth="2" />
            <text x={x} y={y - 4} textAnchor="middle" fontSize="12" fontWeight="700" fill={r ? "#1a1405" : "#9aa1ad"}>{n}</text>
            <text x={x} y={y + 11} textAnchor="middle" fontSize="10" fill={r ? "#1a1405" : "#9aa1ad"}>{r ? name.slice(0, 9) : "free"}</text>
          </g>
        );
      })}
    </svg>
  );
}

function AddPlayer({ tableDayId, full, onMsg }: { tableDayId: string; full: boolean; onMsg: (m: { ok: boolean; text: string }) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Array<{ playerId: string; surname: string; firstNames: string }>>([]);
  async function search(e: FormEvent) {
    e.preventDefault();
    try { setHits((await call<{ players: typeof hits }>("searchPlayers", { query: q })).players.slice(0, 6)); } catch (err) { onMsg({ ok: false, text: (err as Error).message }); }
  }
  async function add(playerId: string) {
    try {
      await call(full ? "joinWaitingList" : "reserveCashPlace", { tableDayId, playerId });
      onMsg({ ok: true, text: full ? "Added to the waiting list." : "Booked." });
      setHits([]); setQ("");
    } catch (err) { onMsg({ ok: false, text: (err as Error).message }); }
  }
  return (
    <div className="stack">
      <form className="row" onSubmit={search}>
        <input style={{ flex: 1 }} placeholder="Add player: ID, name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="secondary" disabled={!q.trim()}>Find</button>
      </form>
      {hits.map((h) => (
        <div key={h.playerId} className="row spread">
          <span>{h.playerId} · {h.surname} {h.firstNames}</span>
          <button onClick={() => void add(h.playerId)}>{full ? "Waiting list" : "Book"}</button>
        </div>
      ))}
    </div>
  );
}
