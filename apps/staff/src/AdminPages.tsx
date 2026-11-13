import { useEffect, useState, type FormEvent } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { call, db, useI18n } from "@tivbook/client";
import { ALL_ROLES, ROLE_LABEL, type Role } from "./roles";

function useCollection<T>(path: string, order?: string) {
  const [rows, setRows] = useState<Array<T & { id: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const q = order ? query(collection(db, path), orderBy(order, "desc")) : collection(db, path);
    return onSnapshot(q, (s) => setRows(s.docs.map((d) => ({ id: d.id, ...(d.data() as T) }))), (e) => setError(e.message));
  }, [path, order]);
  return { rows, error };
}

interface StaffRow { email: string; displayName: string; role: Role; active: boolean }

export function StaffPage({ role }: { role: Role }) {
  const { t, lang } = useI18n();
  const { rows, error } = useCollection<StaffRow>("staff");
  const [form, setForm] = useState({ email: "", displayName: "", role: "cashier" as Role, temporaryPassword: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const L = (r: Role) => ROLE_LABEL[r][lang === "fr" ? 1 : 0];
  const assignable = ALL_ROLES.filter((r) => role === "super_admin" || !["super_admin", "manager"].includes(r));

  async function add(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await call("createStaffUser", form);
      setMsg({ ok: true, text: `${form.displayName} — ${form.email} / ${form.temporaryPassword}` });
      setForm({ email: "", displayName: "", role: "cashier", temporaryPassword: "" });
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  }
  async function update(uid: string, data: Record<string, unknown>) {
    try { await call("updateStaffUser", { uid, ...data }); } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={add}>
        <h2>{t("addStaff")}</h2>
        <div className="grid2">
          <div><label>{t("name")}</label><input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></div>
          <div><label>{t("email")}</label><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div><label>{t("role")}</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{assignable.map((r) => <option key={r} value={r}>{L(r)}</option>)}</select>
          </div>
          <div><label>{t("temporaryPassword")}</label><input required minLength={10} value={form.temporaryPassword} onChange={(e) => setForm({ ...form, temporaryPassword: e.target.value })} /></div>
        </div>
        <button>{t("addStaff")}</button>
        {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
      </form>
      {error && <div className="error">{error}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>{t("name")}</th><th>{t("email")}</th><th>{t("role")}</th><th>{t("active")}</th></tr></thead>
          <tbody>
            {rows.map((s) => {
              const editable = role === "super_admin" || !["super_admin", "manager"].includes(s.role);
              return (
                <tr key={s.id}>
                  <td>{s.displayName}</td><td>{s.email}</td>
                  <td>{editable
                    ? <select value={s.role} onChange={(e) => void update(s.id, { role: e.target.value })}>{assignable.map((r) => <option key={r} value={r}>{L(r)}</option>)}</select>
                    : L(s.role)}</td>
                  <td>{editable
                    ? <button className={s.active ? "secondary" : ""} onClick={() => void update(s.id, { active: !s.active })}>{s.active ? t("active") : t("disabled")}</button>
                    : t("active")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface DeviceRow { name: string; platform: string; status: "pending" | "approved" | "revoked"; requestedAt?: { toDate(): Date } }

export function DevicesPage() {
  const { t } = useI18n();
  const { rows, error } = useCollection<DeviceRow>("staff_devices", "requestedAt");
  const [msg, setMsg] = useState<string | null>(null);
  async function set(id: string, status: "approved" | "revoked") {
    setMsg(null);
    try { await call("setDeviceStatus", { targetDeviceId: id, status }); } catch (e) { setMsg((e as Error).message); }
  }
  return (
    <div className="stack">
      {(error || msg) && <div className="error">{error ?? msg}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>{t("name")}</th><th>ID</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>{d.name || "—"}<div className="small muted">{d.requestedAt?.toDate().toLocaleString()}</div></td>
                <td className="small muted">{d.id.slice(0, 12)}</td>
                <td><span className={`badge ${d.status === "approved" ? "verified" : d.status === "pending" ? "unverified" : "rejected"}`}>{d.status}</span></td>
                <td className="row">
                  {d.status !== "approved" && <button onClick={() => void set(d.id, "approved")}>{t("approve")}</button>}
                  {d.status !== "revoked" && <button className="danger" onClick={() => void set(d.id, "revoked")}>{t("revoke")}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
