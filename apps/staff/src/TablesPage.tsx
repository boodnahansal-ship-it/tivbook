import { useState, type FormEvent } from "react";
import { call, supabase, useI18n, useRows } from "@tivbook/client";

export interface CashTable {
  table_id: string; name: string; game_type: string; small_blind_cents: number; big_blind_cents: number;
  min_buy_in_cents: number; max_buy_in_cents: number; default_capacity: number; active: boolean;
  open_time: string; cutoff_time: string; weekdays: number[]; sort_order: number;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const rs = (cents: number) => `Rs ${(cents / 100).toLocaleString("en-US")}`;
const toCents = (v: string) => Math.round(Number(v.replace(/[^\d.]/g, "")) * 100);

/** Manager: cash tables and their weekly schedule; booking calendar. */
export function TablesPage() {
  const { t } = useI18n();
  const { rows } = useRows<CashTable>("cash_tables", null, { order: "sort_order", ascending: true });
  const [editing, setEditing] = useState<CashTable | "new" | null>(null);
  return (
    <div className="stack">
      <div className="row spread"><h1 style={{ margin: 0 }}>{t("tables")}</h1><button onClick={() => setEditing("new")}>+ Add table</button></div>
      {editing && <TableForm table={editing === "new" ? null : editing} onDone={() => setEditing(null)} />}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Table</th><th>Game · Blinds</th><th>Buy-in</th><th>Seats</th><th>Days</th><th>Times</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.table_id} style={{ opacity: r.active ? 1 : 0.5 }}>
                <td><strong>{r.name}</strong>{!r.active && <div className="small muted">inactive</div>}</td>
                <td>{r.game_type} · {r.small_blind_cents / 100}/{r.big_blind_cents / 100}</td>
                <td>{rs(r.min_buy_in_cents)} – {rs(r.max_buy_in_cents)}</td>
                <td>{r.default_capacity}</td>
                <td className="small">{r.weekdays.length === 7 ? "Every day" : r.weekdays.map((d) => DAYS[d]).join(" ")}</td>
                <td className="small">{r.open_time} · arrive by {r.cutoff_time}</td>
                <td><button className="secondary" onClick={() => setEditing(r)}>Edit</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">No tables yet. Click “Add table”.</td></tr>}
          </tbody>
        </table>
      </div>
      <CalendarForm />
    </div>
  );
}

function TableForm({ table, onDone }: { table: CashTable | null; onDone: () => void }) {
  const [f, setF] = useState({
    name: table?.name ?? "", gameType: table?.game_type ?? "NLH",
    sb: String((table?.small_blind_cents ?? 2500) / 100), bb: String((table?.big_blind_cents ?? 5000) / 100),
    min: String((table?.min_buy_in_cents ?? 200000) / 100), max: String((table?.max_buy_in_cents ?? 1000000) / 100),
    seats: String(table?.default_capacity ?? 9), openTime: table?.open_time ?? "19:00", cutoffTime: table?.cutoff_time ?? "21:00",
    weekdays: table?.weekdays ?? [0, 1, 2, 3, 4, 5, 6], active: table?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await call("upsertCashTable", {
        tableId: table?.table_id, name: f.name, gameType: f.gameType, smallBlindCents: toCents(f.sb), bigBlindCents: toCents(f.bb),
        minBuyInCents: toCents(f.min), maxBuyInCents: toCents(f.max), defaultCapacity: Number(f.seats),
        openTime: f.openTime, cutoffTime: f.cutoffTime, weekdays: f.weekdays, active: f.active,
      });
      onDone();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <form className="card stack" onSubmit={save}>
      <h2>{table ? `Edit ${table.name}` : "New table"}</h2>
      <div className="grid2">
        <div><label>Table name</label><input required value={f.name} onChange={set("name")} placeholder="Table 1" /></div>
        <div><label>Game</label><select value={f.gameType} onChange={set("gameType")}><option>NLH</option><option>PLO</option><option>PLO5</option><option>Mixed</option></select></div>
        <div><label>Small blind (Rs)</label><input inputMode="decimal" value={f.sb} onChange={set("sb")} /></div>
        <div><label>Big blind (Rs)</label><input inputMode="decimal" value={f.bb} onChange={set("bb")} /></div>
        <div><label>Minimum buy-in (Rs)</label><input inputMode="decimal" required value={f.min} onChange={set("min")} /></div>
        <div><label>Maximum buy-in (Rs)</label><input inputMode="decimal" required value={f.max} onChange={set("max")} /></div>
        <div><label>Seats</label><input type="number" min={2} max={12} value={f.seats} onChange={set("seats")} /></div>
        <div className="row">
          <div style={{ flex: 1 }}><label>Starts</label><input type="time" value={f.openTime} onChange={set("openTime")} /></div>
          <div style={{ flex: 1 }}><label>Arrive by (cut-off)</label><input type="time" value={f.cutoffTime} onChange={set("cutoffTime")} /></div>
        </div>
      </div>
      <div>
        <label>Days the table runs</label>
        <div className="chips">
          {DAYS.map((d, i) => (
            <button type="button" key={d} className={`chip ${f.weekdays.includes(i) ? "on" : ""}`}
              onClick={() => setF({ ...f, weekdays: f.weekdays.includes(i) ? f.weekdays.filter((x) => x !== i) : [...f.weekdays, i].sort() })}>{d}</button>
          ))}
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />Active (open for booking)</label>
      {error && <div className="error">{error}</div>}
      <div className="row"><button disabled={busy}>Save</button><button type="button" className="secondary" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function CalendarForm() {
  const { rows } = useRows<{ key: string; value: { openWeekday: number; openTime: string; closedDates: string[] } }>("settings", { column: "key", value: "booking_calendar" });
  const cur = rows[0]?.value;
  const [closed, setClosed] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save(data: Record<string, unknown>) {
    setMsg(null);
    try { await call("setBookingCalendar", data); setMsg({ ok: true, text: "Saved." }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  if (!cur) return null;
  return (
    <div className="card stack">
      <h2>Booking calendar</h2>
      <p className="muted small">Players can book the following Monday–Sunday from this moment each week (Mauritius time).</p>
      <div className="row">
        <select style={{ width: "auto" }} value={cur.openWeekday} onChange={(e) => void save({ openWeekday: Number(e.target.value) })}>
          {DAYS.map((d, i) => <option key={d} value={i}>Opens on {d}</option>)}
        </select>
        <input type="time" style={{ width: "auto" }} value={cur.openTime} onChange={(e) => void save({ openTime: e.target.value })} />
      </div>
      <div>
        <label>Closed dates (no cash games)</label>
        <div className="chips">{cur.closedDates.map((d) => <button key={d} className="chip" onClick={() => void save({ closedDates: cur.closedDates.filter((x) => x !== d) })}>{d} ✕</button>)}</div>
        <div className="row" style={{ marginTop: ".4rem" }}>
          <input type="date" style={{ width: "auto" }} value={closed} onChange={(e) => setClosed(e.target.value)} />
          <button className="secondary" disabled={!closed} onClick={() => { void save({ closedDates: [...cur.closedDates, closed] }); setClosed(""); }}>Add closed date</button>
        </div>
      </div>
      {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
    </div>
  );
}

/** Names for a list of player IDs (staff can read players). */
export async function playerNames(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const { data } = await supabase().from("players").select("player_id,surname,first_names,kyc_status").in("player_id", ids);
  return Object.fromEntries((data ?? []).map((p: { player_id: string; surname: string; first_names: string }) => [p.player_id, `${p.surname} ${p.first_names}`]));
}
