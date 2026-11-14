import type { Ctx, Handler } from "./context.js";
import { ApiError } from "./util.js";
import { listDeskCodes, requestOtp, verifyOtpCode } from "./handlers/otp.js";
import { getIdDocumentImage, registerPlayer, registerPushToken, searchPlayers, setKycStatus, uploadIdDocument } from "./handlers/players.js";
import { bootstrapSuperAdmin, createStaffUser, getIntegrationStatus, passwordChanged, requestDeviceApproval, setDeviceStatus, setIntegrations, updateStaffUser } from "./handlers/staff.js";
import { cancelCashReservation, joinWaitingList, notifyPlaceReleased, reserveCashPlace, respondPlaceOffer } from "./handlers/cash.js";
import { checkInReservation, cronTick, leaveTable, leaveWaitingList, myWaitingPositions, seatPlayer, setBookingCalendar, setTableDay, upsertCashTable } from "./handlers/tables.js";
import { confirmChipDelivery, recordTournamentPayment, validateTicket } from "./handlers/tournaments.js";

/** Every server action TiVBook has. One server function ("api") handles them all. */
export const ACTIONS: Record<string, Handler> = {
  ping: async () => ({ ok: true, service: "tivbook", version: "0.4.0" }),
  requestOtp, verifyOtpCode, listDeskCodes,
  registerPlayer, uploadIdDocument, getIdDocumentImage, setKycStatus, searchPlayers, registerPushToken,
  createStaffUser, updateStaffUser, requestDeviceApproval, setDeviceStatus, passwordChanged, bootstrapSuperAdmin, setIntegrations, getIntegrationStatus,
  reserveCashPlace, cancelCashReservation, joinWaitingList, respondPlaceOffer, notifyPlaceReleased, cronTick,
  upsertCashTable, setTableDay, setBookingCalendar, checkInReservation, seatPlayer, leaveTable, leaveWaitingList, myWaitingPositions,
  recordTournamentPayment, validateTicket, confirmChipDelivery,
};

export type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };

export async function dispatch(ctx: Ctx, action: string, data: Record<string, unknown>): Promise<{ status: number; body: Reply }> {
  const handler = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : undefined;
  if (!handler) return { status: 404, body: { ok: false, error: { code: "UNKNOWN_ACTION", message: `Unknown action "${action}".` } } };
  try {
    return { status: 200, body: { ok: true, data: await handler(ctx, data ?? {}) } };
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, body: { ok: false, error: { code: e.code, message: e.message, details: e.details } } };
    const pg = e as { code?: string; message?: string };
    if (pg?.code === "23514") return { status: 409, body: { ok: false, error: { code: "CONFLICT", message: "That change is not allowed right now (the table may be full). Please refresh and try again." } } };
    if (pg?.code === "40P01" || pg?.code === "40001") return { status: 409, body: { ok: false, error: { code: "BUSY", message: "Busy — please try again." } } };
    console.error("Unhandled error", action, e);
    return { status: 500, body: { ok: false, error: { code: "INTERNAL", message: "Something went wrong. Please try again." } } };
  }
}
