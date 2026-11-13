import { initializeApp, type FirebaseOptions } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable, type FunctionsError } from "firebase/functions";

/**
 * One online backend for both the staff software and the player app.
 * Configuration comes from the .env file created by the setup script.
 */
const env = import.meta.env;
const config: FirebaseOptions = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? "demo-tivbook",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(config);
export const auth = getAuth(app);
/** Offline cache: screens keep working through short Wi-Fi drops and resync automatically. */
export const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
export const functions = getFunctions(app, "europe-west1");

if (env.VITE_USE_EMULATORS === "true") {
  const host = env.VITE_EMULATOR_HOST ?? "localhost";
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
}

/** Staff software sets this once the device is registered; it is sent with every call. */
let deviceId: string | null = null;
export function setDeviceId(id: string | null) {
  deviceId = id;
}

export class ApiError extends Error {
  constructor(message: string, public code: string, public details?: unknown) {
    super(message);
  }
}

/** Calls a Cloud Function and returns its data, with readable errors. */
export async function call<T = unknown>(name: string, data: Record<string, unknown> = {}): Promise<T> {
  try {
    const res = await httpsCallable(functions, name, { timeout: 60_000 })({ ...data, ...(deviceId ? { deviceId } : {}) });
    return res.data as T;
  } catch (e) {
    const err = e as FunctionsError;
    const details = err.details as { code?: string } | undefined;
    const msg = err.code === "functions/unavailable" || err.code === "functions/internal" && !err.message
      ? "Connection problem. Check the internet and try again."
      : err.message;
    throw new ApiError(msg, details?.code ?? err.code ?? "unknown", err.details);
  }
}

/** Random idempotency key for money/ticket actions. */
export function newKey(): string {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
