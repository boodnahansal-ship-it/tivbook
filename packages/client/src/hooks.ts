import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "./connection";

export interface Session {
  user: User | null;
  /** Server-set account data: role, player_id, phone… (cannot be changed by the app). */
  claims: Record<string, unknown>;
  ready: boolean;
}

export function useSession(): Session {
  const [s, setS] = useState<Session>({ user: null, claims: {}, ready: false });
  useEffect(() => {
    const sb = supabase();
    void sb.auth.getSession().then(({ data }) => setS({ user: data.session?.user ?? null, claims: data.session?.user.app_metadata ?? {}, ready: true }));
    const { data } = sb.auth.onAuthStateChange((_e, session) => setS({ user: session?.user ?? null, claims: session?.user.app_metadata ?? {}, ready: true }));
    return () => data.subscription.unsubscribe();
  }, []);
  return s;
}

/** Fetches fresh account data from the server (e.g. after registration adds the Player ID). */
export async function refreshSession() {
  await supabase().auth.refreshSession();
}

let channelSeq = 0;

/**
 * Live rows: loads once, then updates instantly when any PC, phone or the server changes
 * them (Supabase Realtime). Reloads when the connection comes back.
 */
export function useRows<T = Record<string, unknown>>(
  table: string,
  filter: { column: string; value: string | number | boolean | null } | null,
  opts: { order?: string; ascending?: boolean; enabled?: boolean } = {},
): { rows: T[]; loading: boolean; error: string | null; reload: () => void } {
  const [state, setState] = useState<{ rows: T[]; loading: boolean; error: string | null }>({ rows: [], loading: true, error: null });
  const [tick, setTick] = useState(0);
  const enabled = opts.enabled !== false;
  const key = JSON.stringify([table, filter, opts.order, opts.ascending, enabled, tick]);

  useEffect(() => {
    if (!enabled) {
      setState({ rows: [], loading: false, error: null });
      return;
    }
    const sb = supabase();
    let cancelled = false;
    const load = async () => {
      let q = sb.from(table).select("*");
      if (filter) q = filter.value === null ? q.is(filter.column, null) : q.eq(filter.column, filter.value);
      if (opts.order) q = q.order(opts.order, { ascending: opts.ascending ?? false });
      const { data, error } = await q.limit(500);
      if (!cancelled) setState({ rows: (data as T[]) ?? [], loading: false, error: error?.message ?? null });
    };
    void load();
    const channel = sb
      .channel(`tv-${table}-${++channelSeq}`)
      .on("postgres_changes", { event: "*", schema: "public", table, ...(filter && filter.value !== null ? { filter: `${filter.column}=eq.${filter.value}` } : {}) }, () => void load())
      .subscribe();
    const online = () => void load();
    window.addEventListener("online", online);
    // Safety net if the live connection drops (e.g. weak Wi-Fi): quiet refresh every 30 s while visible.
    const poll = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    const refreshAll = () => void load();
    window.addEventListener("tivbook:refresh", refreshAll);
    return () => {
      cancelled = true;
      clearInterval(poll);
      window.removeEventListener("online", online);
      window.removeEventListener("tivbook:refresh", refreshAll);
      void sb.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}

/** One live row by key. */
export function useRow<T = Record<string, unknown>>(table: string, column: string, value: string | null) {
  const r = useRows<T>(table, value ? { column, value } : null, { enabled: !!value });
  return { data: r.rows[0] ?? null, loading: r.loading, error: r.error };
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}
