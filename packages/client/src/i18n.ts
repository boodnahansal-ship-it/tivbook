import { createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "fr";

/** All UI text, English and French. Mauritian Creole can be added as a third column later. */
const T = {
  appName: ["TiVBook", "TiVBook"],
  welcome: ["Welcome", "Bienvenue"],
  signIn: ["Sign in", "Se connecter"],
  signOut: ["Sign out", "Se déconnecter"],
  email: ["Email", "E-mail"],
  password: ["Password", "Mot de passe"],
  continue: ["Continue", "Continuer"],
  cancel: ["Cancel", "Annuler"],
  save: ["Save", "Enregistrer"],
  back: ["Back", "Retour"],
  loading: ["Loading…", "Chargement…"],
  search: ["Search", "Rechercher"],
  // phone + OTP
  mobileNumber: ["Mobile number", "Numéro de mobile"],
  mobileHint: ["We will send a code by WhatsApp. Mauritius numbers can be typed without +230.", "Nous enverrons un code par WhatsApp. Les numéros mauriciens peuvent être saisis sans +230."],
  sendCode: ["Send code by WhatsApp", "Envoyer le code par WhatsApp"],
  enterCode: ["Enter the 6-digit code", "Saisissez le code à 6 chiffres"],
  codeSentTo: ["Code sent by WhatsApp to", "Code envoyé par WhatsApp au"],
  verify: ["Verify", "Vérifier"],
  codeAtDesk: ["Go to the cashier or front desk at Ti Vegas and ask for your TiVBook code. Bring your ID card or passport. The code is valid for 15 minutes.", "Rendez-vous à la caisse ou à l'accueil du Ti Vegas et demandez votre code TiVBook. Munissez-vous de votre carte d'identité ou passeport. Le code est valable 15 minutes."],
  codeForNumber: ["Code for", "Code pour"],
  signInCodes: ["Sign-in codes", "Codes de connexion"],
  signInCodesHint: ["Players who sign in to the app without WhatsApp get their code here. Check their ID, then read them the code for their number.", "Les joueurs qui se connectent à l'application sans WhatsApp reçoivent leur code ici. Vérifiez leur pièce d'identité, puis donnez-leur le code de leur numéro."],
  noCodes: ["No codes waiting.", "Aucun code en attente."],
  expiresIn: ["expires in", "expire dans"],
  newPlayer: ["New player", "Nouveau joueur"],
  resend: ["Send a new code", "Renvoyer un code"],
  changeNumber: ["Change number", "Changer de numéro"],
  // registration
  register: ["Register", "Inscription"],
  registerPlayer: ["Register a player", "Inscrire un joueur"],
  namesMustMatch: ["Names must match your ID card or passport exactly.", "Les noms doivent correspondre exactement à votre carte d'identité ou passeport."],
  surname: ["Surname", "Nom"],
  firstNames: ["First name(s)", "Prénom(s)"],
  dateOfBirth: ["Date of birth", "Date de naissance"],
  address: ["Residential address", "Adresse de résidence"],
  countryOfResidence: ["Country of residence", "Pays de résidence"],
  nationality: ["Nationality", "Nationalité"],
  idDocType: ["Identity document", "Pièce d'identité"],
  nationalId: ["National ID card", "Carte d'identité nationale"],
  passport: ["Passport", "Passeport"],
  idDocNumber: ["Document number", "Numéro du document"],
  acceptTerms: ["I accept the Terms and the Privacy Policy", "J'accepte les Conditions et la Politique de confidentialité"],
  // ID photos
  idPhotos: ["Identity document photos", "Photos de la pièce d'identité"],
  idPhotosHint: ["Take clear photos with all four corners visible and no glare.", "Prenez des photos nettes, les quatre coins visibles et sans reflet."],
  id_front: ["ID card — front", "Carte d'identité — recto"],
  id_back: ["ID card — back", "Carte d'identité — verso"],
  passportPage: ["Passport photo page", "Page photo du passeport"],
  takePhoto: ["Take or choose photo", "Prendre ou choisir une photo"],
  replace: ["Replace", "Remplacer"],
  uploaded: ["Uploaded", "Envoyé"],
  uploading: ["Uploading…", "Envoi…"],
  done: ["Done", "Terminé"],
  // player
  yourPlayerId: ["Your Player ID", "Votre ID joueur"],
  showAtCashier: ["Show this number at the cashier.", "Présentez ce numéro à la caisse."],
  identity: ["Identity", "Identité"],
  kyc_unverified: ["To be verified at the cashier with your original document", "À vérifier à la caisse avec votre document original"],
  kyc_verified: ["Verified", "Vérifiée"],
  kyc_rejected: ["Rejected — please contact the cashier", "Refusée — veuillez contacter la caisse"],
  addIdPhotos: ["Add ID photos", "Ajouter les photos d'identité"],
  profile: ["Profile", "Profil"],
  home: ["Home", "Accueil"],
  language: ["Language", "Langue"],
  // staff
  players: ["Players", "Joueurs"],
  searchHint: ["Player ID, name, phone or document number", "ID joueur, nom, téléphone ou n° de document"],
  noResults: ["No player found.", "Aucun joueur trouvé."],
  playerCard: ["Player card", "Fiche joueur"],
  verifyIdentity: ["Confirm identity verified", "Confirmer l'identité vérifiée"],
  rejectIdentity: ["Reject", "Refuser"],
  reason: ["Reason", "Motif"],
  viewPhoto: ["View photo", "Voir la photo"],
  administration: ["Administration", "Administration"],
  staffAccounts: ["Staff accounts", "Comptes du personnel"],
  devices: ["Devices", "Appareils"],
  approve: ["Approve", "Approuver"],
  revoke: ["Revoke", "Révoquer"],
  addStaff: ["Add staff member", "Ajouter un membre du personnel"],
  name: ["Name", "Nom"],
  role: ["Role", "Rôle"],
  active: ["Active", "Actif"],
  disabled: ["Disabled", "Désactivé"],
  temporaryPassword: ["Temporary password", "Mot de passe temporaire"],
  deviceWaiting: ["This computer is waiting for approval", "Cet ordinateur attend l'approbation"],
  deviceWaitingHint: ["Ask a manager to approve it in Administration → Devices. This screen updates by itself.", "Demandez à un responsable de l'approuver dans Administration → Appareils. Cet écran se met à jour tout seul."],
  deviceName: ["Name for this computer (e.g. Cashier 1)", "Nom de cet ordinateur (ex. Caisse 1)"],
  changePassword: ["Choose a new password", "Choisissez un nouveau mot de passe"],
  newPassword: ["New password (min. 10 characters)", "Nouveau mot de passe (min. 10 caractères)"],
  online: ["Online", "En ligne"],
  // connection & setup
  connectTitle: ["Connect to your casino", "Connecter à votre casino"],
  connectHint: ["Enter the TiVBook connection code (starts with TVB1-). Ask the cashier, or scan the QR code shown at Ti Vegas.", "Saisissez le code de connexion TiVBook (commence par TVB1-). Demandez à la caisse ou scannez le QR code affiché au Ti Vegas."],
  connectionCode: ["Connection code", "Code de connexion"],
  connect: ["Connect", "Connecter"],
  scanQr: ["Scan QR code", "Scanner le QR code"],
  invalidCode: ["This code is not valid. Check it and try again.", "Ce code n'est pas valide. Vérifiez-le et réessayez."],
  settings: ["Settings", "Paramètres"],
  // cash games
  cashGames: ["Cash Games", "Cash Games"],
  myBookings: ["My Bookings", "Mes réservations"],
  tables: ["Tables", "Tables"],
  floor: ["Floor", "Salle"],
  book: ["Book a place", "Réserver une place"],
  booked: ["Booked", "Réservé"],
  full: ["Full", "Complet"],
  placesLeft: ["places left", "places libres"],
  joinWaitingList: ["Join the waiting list", "Liste d'attente"],
  onWaitingList: ["On the waiting list", "En liste d'attente"],
  positionInQueue: ["Position", "Position"],
  leaveList: ["Leave the list", "Quitter la liste"],
  cancelBooking: ["Cancel booking", "Annuler la réservation"],
  bookingRules: ["One place per day. Arrive before the cut-off time or your place is released.", "Une place par jour. Arrivez avant l'heure limite, sinon votre place est libérée."],
  noTables: ["No tables open for booking on this day.", "Aucune table ouverte à la réservation ce jour-là."],
  bookingsOpen: ["Bookings for next week open on Sunday at", "Les réservations de la semaine prochaine ouvrent le dimanche à"],
  cutoff: ["Arrive by", "Arrivée avant"],
  starts: ["Starts", "Début"],
  buyIn: ["Buy-in", "Cave"],
  noBookings: ["You have no upcoming bookings.", "Vous n'avez aucune réservation à venir."],
  status_reserved: ["Booked", "Réservé"],
  status_checked_in: ["Arrived", "Arrivé"],
  status_seated: ["Seated", "Assis"],
  placeAvailable: ["TI VEGAS — PLACE AVAILABLE!", "TI VEGAS — PLACE DISPONIBLE !"],
  placeAvailableText: ["A place is available at", "Une place est disponible à la"],
  acceptPlace: ["Accept place", "Accepter la place"],
  decline: ["Decline", "Refuser"],
  offerExpired: ["This offer has expired.", "Cette offre a expiré."],
  confirmCancel: ["Cancel this booking?", "Annuler cette réservation ?"],
  alarmsOn: ["Alarm sound on", "Alarme sonore activée"],
  testAlarm: ["Test the alarm", "Tester l'alarme"],
  offline: ["Offline — changes will sync when the connection returns", "Hors ligne — synchronisation au retour de la connexion"],
} satisfies Record<string, [string, string]>;

export type TKey = keyof typeof T;

interface I18n { lang: Lang; setLang: (l: Lang) => void; t: (k: TKey) => string }
const Ctx = createContext<I18n | null>(null);

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("tivbook.lang");
    if (saved === "en" || saved === "fr") return saved;
  } catch { /* storage unavailable */ }
  return navigator.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem("tivbook.lang", l); } catch { /* ignore */ }
  }, []);
  const value = useMemo<I18n>(() => ({ lang, setLang, t: (k) => T[k][lang === "fr" ? 1 : 0] }), [lang, setLang]);
  return createElement(Ctx.Provider, { value }, children);
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
