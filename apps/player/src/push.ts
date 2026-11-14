import { call } from "@tivbook/client";

/**
 * Phone alarms when the app is closed or the phone is locked (Firebase Cloud Messaging, free).
 * Only active in the Android/iOS app built with a google-services.json file (VITE_PUSH_ENABLED);
 * otherwise players still get the in-app alarm whenever TiVBook is open.
 */
export async function setupPush(): Promise<"on" | "off" | "denied"> {
  const native = (window as unknown as { Capacitor?: { isNativePlatform(): boolean } }).Capacitor?.isNativePlatform?.();
  if (!native || import.meta.env.VITE_PUSH_ENABLED !== "true") return "off";
  const { PushNotifications } = await import("@capacitor/push-notifications");
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== "granted") return "denied";
  await PushNotifications.createChannel({
    id: "place_available", name: "Place available", description: "A place is available at your table",
    importance: 5, visibility: 1, sound: "tivbook_place_available", vibration: true, lights: true,
  }).catch(() => {});
  await PushNotifications.createChannel({ id: "reminders", name: "Reminders", importance: 3 }).catch(() => {});
  await PushNotifications.addListener("registration", (tk) => {
    void call("registerPushToken", { token: tk.value, platform: "android" }).catch(() => {});
  });
  await PushNotifications.register();
  return "on";
}
