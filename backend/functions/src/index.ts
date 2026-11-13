// TiVBook Cloud Functions — one backend for the staff software and the player app.
export { requestOtp, verifyOtpCode } from "./otp.js";
export { registerPlayer, uploadIdDocument, getIdDocumentImage, setKycStatus, searchPlayers } from "./players.js";
export { createStaffUser, updateStaffUser, requestDeviceApproval, setDeviceStatus, passwordChanged, bootstrapSuperAdmin } from "./staff.js";
export {
  reserveCashPlace, cancelCashReservation, expireReservationsAtCutoff,
  joinWaitingList, respondPlaceOffer, expirePlaceOffers, notifyPlaceReleased,
} from "./cashGames.js";
export { recordTournamentPayment, validateTicket, confirmChipDelivery } from "./tournaments.js";
