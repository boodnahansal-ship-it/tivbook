import { useEffect, useState } from "react";
import { onIdTokenChanged, type User } from "firebase/auth";
import { doc, onSnapshot, type DocumentData } from "firebase/firestore";
import { auth, db } from "./firebase";

export interface Session {
  user: User | null;
  claims: Record<string, unknown>;
  ready: boolean;
}

/** Signed-in user + custom claims (role, playerId). Refreshes when claims change. */
export function useSession(): Session {
  const [s, setS] = useState<Session>({ user: null, claims: {}, ready: false });
  useEffect(
    () =>
      onIdTokenChanged(auth, async (user) => {
        const claims = user ? (await user.getIdTokenResult()).claims : {};
        setS({ user, claims: claims as Record<string, unknown>, ready: true });
      }),
    [],
  );
  return s;
}

/** Live document: updates instantly when anything changes it (staff PC, app, server). */
export function useDoc<T = DocumentData>(path: string | null): { data: (T & { id: string }) | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ data: (T & { id: string }) | null; loading: boolean; error: string | null }>({ data: null, loading: !!path, error: null });
  useEffect(() => {
    if (!path) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      doc(db, path),
      (snap) => setState({ data: snap.exists() ? ({ id: snap.id, ...(snap.data() as T) }) : null, loading: false, error: null }),
      (e) => setState({ data: null, loading: false, error: e.message }),
    );
  }, [path]);
  return state;
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
