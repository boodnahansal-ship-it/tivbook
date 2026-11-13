import { defineSecret, defineString } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";

/**
 * WhatsApp Business Cloud API (Meta) — authentication template with a copy-code button.
 * Setup: create an "Authentication" template (e.g. `tivbook_otp`) in WhatsApp Manager,
 * then set WHATSAPP_TOKEN (secret) and WHATSAPP_PHONE_NUMBER_ID.
 */
export const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
export const WHATSAPP_PHONE_NUMBER_ID = defineString("WHATSAPP_PHONE_NUMBER_ID", { default: "" });
export const WHATSAPP_TEMPLATE = defineString("WHATSAPP_TEMPLATE", { default: "tivbook_otp" });
export const WHATSAPP_LANG = defineString("WHATSAPP_TEMPLATE_LANG", { default: "en" });

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === "true";

export async function sendWhatsAppOtp(phoneE164: string, code: string): Promise<{ messageId: string }> {
  const token = WHATSAPP_TOKEN.value();
  const phoneNumberId = WHATSAPP_PHONE_NUMBER_ID.value();
  if (!token || !phoneNumberId) {
    // Local testing only: never active in a deployed project.
    if (isEmulator()) {
      logger.warn(`[EMULATOR ONLY] WhatsApp not configured. OTP for ${phoneE164}: ${code}`);
      return { messageId: "emulator" };
    }
    throw new Error("WhatsApp is not configured.");
  }
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phoneE164.replace("+", ""),
      type: "template",
      template: {
        name: WHATSAPP_TEMPLATE.value(),
        language: { code: WHATSAPP_LANG.value() },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ],
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string; code?: number } };
  if (!res.ok || !body.messages?.[0]) {
    logger.error("WhatsApp send failed", { status: res.status, error: body.error });
    throw new Error(body.error?.message ?? `WhatsApp error ${res.status}`);
  }
  return { messageId: body.messages[0].id };
}
