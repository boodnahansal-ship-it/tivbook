import { getConnection, supabase } from "./connection";

/** Staff software sets this once the computer is registered; it is sent with every call. */
let deviceId: string | null = null;
export function setDeviceId(id: string | null) {
  deviceId = id;
}

export class ApiError extends Error {
  constructor(message: string, public code: string, public details?: unknown) {
    super(message);
  }
}

/** Calls a TiVBook server action and returns its data, with readable errors. */
export async function call<T = unknown>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const conn = getConnection();
  if (!conn) throw new ApiError("TiVBook is not connected to a casino yet.", "NOT_CONNECTED");
  const { data: s } = await supabase().auth.getSession();
  let res: Response;
  try {
    res = await fetch(`${conn.url}/functions/v1/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: conn.anonKey, Authorization: `Bearer ${s.session?.access_token ?? conn.anonKey}` },
      body: JSON.stringify({ action, data: { ...data, ...(deviceId ? { deviceId } : {}) } }),
    });
  } catch {
    throw new ApiError("Connection problem. Check the internet and try again.", "OFFLINE");
  }
  const body = (await res.json().catch(() => null)) as { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } } | null;
  if (!body) throw new ApiError("The server did not answer correctly. Please try again.", "BAD_RESPONSE");
  if (!body.ok) throw new ApiError(body.error!.message, body.error!.code, body.error!.details);
  return body.data as T;
}

/** Random idempotency key for money/ticket actions. */
export function newKey(): string {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
