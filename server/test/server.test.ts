import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { muToInstant } from "@tivbook/core";
import type { Caller } from "../src/context.js";
import { createTestDb, World } from "./harness.js";

let db: { sql: Sql; drop: () => Promise<void> };
let w: World;
let admin: Caller;
let cashier: Caller;
const ADMIN_DEVICE = "dev_admin_0000000001";
const CASHIER_DEVICE = "dev_cashier_00000001";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(2000).fill(7)]);
const b64 = Buffer.from(JPEG).toString("base64");

beforeAll(async () => {
  db = await createTestDb();
  w = new World(db.sql);
}, 60_000);
afterAll(async () => db?.drop());

/** Full WhatsApp sign-in → registration of a player; returns the player caller. */
async function newPlayer(phone: string, surname: string): Promise<Caller> {
  await w.call(null, "requestOtp", { phone });
  const code = w.fakes.sentCodes.at(-1)!.code;
  w.clock += 31_000; // past resend cooldown for the next test
  await w.call(null, "verifyOtpCode", { phone, code });
  const uid = [...w.fakes.users.entries()].find(([, u]) => u.app_metadata.phone_e164 === phone)![0];
  const r = await w.call(w.fakes.callerFor(uid), "registerPlayer", {
    surname, firstNames: "Marie Hélène", phone, dateOfBirth: "1990-05-01", address: "Grand Baie", idDocType: "national_id",
    idDocNumber: `M${phone.slice(-7)}`, acceptedTerms: true,
  });
  expect(r.playerId).toMatch(/^\d{3}$/);
  return w.fakes.callerFor(uid);
}

describe("setup and staff", () => {
  it("creates the first Super Administrator only once, with the setup code", async () => {
    expect(await w.code(null, "bootstrapSuperAdmin", { setupCode: "wrong-code-12345", email: "a@b.mu", password: "0123456789" })).toBe("PERMISSION_DENIED");
    const r = await w.call(null, "bootstrapSuperAdmin", { setupCode: "setup-code-123456", email: "boss@tivegas.mu", password: "0123456789", displayName: "Jennifer Moreau" });
    admin = w.fakes.callerFor(r.uid, ADMIN_DEVICE);
    expect(admin.role).toBe("super_admin");
    expect(await w.code(null, "bootstrapSuperAdmin", { setupCode: "setup-code-123456", email: "x@b.mu", password: "0123456789" })).toBe("ALREADY_SET_UP");
  });

  it("approves the super admin's device at once; other staff wait for approval", async () => {
    expect((await w.call(admin, "requestDeviceApproval", { deviceId: ADMIN_DEVICE, name: "Office" })).status).toBe("approved");
    const r = await w.call(admin, "createStaffUser", { email: "devika@tivegas.mu", displayName: "Devika", role: "cashier", temporaryPassword: "Temp-pass-1" });
    cashier = w.fakes.callerFor(r.uid, CASHIER_DEVICE);
    expect((await w.call(cashier, "requestDeviceApproval", { deviceId: CASHIER_DEVICE, name: "Cashier 1" })).status).toBe("pending");
    expect(await w.code(cashier, "searchPlayers", { query: "001" })).toBe("DEVICE_NOT_APPROVED");
    await w.call(admin, "setDeviceStatus", { targetDeviceId: CASHIER_DEVICE, status: "approved" });
    expect(await w.code(cashier, "searchPlayers", { query: "001" })).toBe("OK");
    // a cashier cannot create staff
    expect(await w.code(cashier, "createStaffUser", { email: "x@x.mu", displayName: "X", role: "dealer", temporaryPassword: "0123456789" })).toBe("PERMISSION_DENIED");
  });

  it("disabling a staff account blocks it immediately", async () => {
    const r = await w.call(admin, "createStaffUser", { email: "floor@tivegas.mu", displayName: "Floor", role: "floor_supervisor", temporaryPassword: "Temp-pass-1" });
    const floor = w.fakes.callerFor(r.uid, "dev_floor_0000000001");
    await w.call(floor, "requestDeviceApproval", { deviceId: "dev_floor_0000000001" });
    await w.call(admin, "setDeviceStatus", { targetDeviceId: "dev_floor_0000000001", status: "approved" });
    await w.call(admin, "updateStaffUser", { uid: r.uid, active: false });
    expect(w.fakes.users.get(r.uid)!.banned).toBe(true);
    expect(await w.code(floor, "searchPlayers", { query: "001" })).toBe("PERMISSION_DENIED");
  });
});

describe("WhatsApp verification and registration", () => {
  it("verifies codes with attempt limits and creates a login", async () => {
    await w.call(null, "requestOtp", { phone: "5711 0000" });
    const sent = w.fakes.sentCodes.at(-1)!;
    expect(sent.phone).toBe("+23057110000");
    expect(await w.code(null, "requestOtp", { phone: "57110000" })).toBe("COOLDOWN");
    expect(await w.code(null, "verifyOtpCode", { phone: "57110000", code: sent.code === "000000" ? "111111" : "000000" })).toBe("WRONG_CODE");
    const r = await w.call(null, "verifyOtpCode", { phone: "57110000", code: sent.code });
    expect(r.email).toMatch(/@players\.tivbook\.app$/);
    expect(r.password.length).toBeGreaterThan(20);
    expect(r.playerId).toBeNull();
    expect(await w.code(null, "verifyOtpCode", { phone: "57110000", code: sent.code })).toBe("ALREADY_USED");
    w.clock += 31_000;
  });

  it("allocates sequential player IDs 001, 002 and refuses duplicates and minors", async () => {
    const p1 = await newPlayer("+23057120001", "MOREAU");
    const p2 = await newPlayer("+23057120002", "CARJOU");
    expect(p1.playerId).toBe("001");
    expect(p2.playerId).toBe("002");
    // staff registration of a duplicate phone
    expect(await w.code(cashier, "registerPlayer", { surname: "X", firstNames: "Y", phone: "+23057120001", dateOfBirth: "1990-01-01", idDocType: "passport", idDocNumber: "P1", acceptedTerms: true })).toBe("PHONE_EXISTS");
    expect(await w.code(cashier, "registerPlayer", { surname: "YOUNG", firstNames: "Kid", phone: "+23057129999", dateOfBirth: "2010-01-01", idDocType: "passport", idDocNumber: "P2", acceptedTerms: true })).toBe("UNDER_AGE");
    expect(await w.code(cashier, "registerPlayer", { surname: "J0HN", firstNames: "Bad", phone: "+23057129998", dateOfBirth: "1990-01-01", idDocType: "passport", idDocNumber: "P3", acceptedTerms: true })).toBe("INVALID_NAME");
    const staffMade = await w.call(cashier, "registerPlayer", { surname: "PASSPORT", firstNames: "Guest", phone: "+33612345678", dateOfBirth: "1985-03-03", idDocType: "passport", idDocNumber: "18AB12345", acceptedTerms: true, nationality: "French" });
    expect(staffMade.playerId).toBe("003");
  });

  it("links the app to a player first registered at the front desk", async () => {
    await w.call(null, "requestOtp", { phone: "+33612345678" });
    const r = await w.call(null, "verifyOtpCode", { phone: "+33612345678", code: w.fakes.sentCodes.at(-1)!.code });
    expect(r.playerId).toBe("003");
    w.clock += 31_000;
  });

  it("uploads ID photos, then the cashier verifies identity", async () => {
    const p = w.fakes.callerFor([...w.fakes.users.entries()].find(([, u]) => u.app_metadata.player_id === "001")![0]);
    expect(await w.code(cashier, "setKycStatus", { playerId: "001", status: "verified" })).toBe("MISSING_PHOTOS");
    expect(await w.code(p, "uploadIdDocument", { kind: "id_front", base64: Buffer.from("%PDF-1.4" + "x".repeat(2000)).toString("base64") })).toBe("INVALID_IMAGE");
    await w.call(p, "uploadIdDocument", { kind: "id_front", base64: b64 });
    await w.call(cashier, "uploadIdDocument", { playerId: "001", kind: "id_back", base64: b64 });
    const docs = await db.sql`select id from identity_documents where player_id = '001' and replaced_by is null`;
    expect(docs.length).toBe(2);
    const img = await w.call(cashier, "getIdDocumentImage", { documentId: docs[0]!.id });
    expect(img.contentType).toBe("image/jpeg");
    await w.call(cashier, "setKycStatus", { playerId: "001", status: "verified" });
    const [row] = await db.sql`select kyc_status from players where player_id = '001'`;
    expect(row!.kyc_status).toBe("verified");
  });

  it("finds players by ID, name, phone and document number", async () => {
    const ids = async (q: string) => (await w.call(cashier, "searchPlayers", { query: q })).players.map((p: any) => p.playerId);
    expect(await ids("1")).toContain("001");
    expect(await ids("moreau")).toEqual(["001"]);
    expect(await ids("helene")).toEqual(expect.arrayContaining(["001", "002"]));
    expect(await ids("5712 0002")).toEqual(["002"]);
    expect(await ids("18AB12345")).toEqual(["003"]);
  });
});

describe("cash-game reservations", () => {
  const cutoff = new Date(muToInstant("2026-11-19", "21:00"));
  beforeAll(async () => {
    await db.sql`insert into cash_tables (table_id, name, min_buy_in_cents, max_buy_in_cents) values ('T1','Table 1',200000,1000000), ('T2','Table 2',500000,2500000)`;
    await db.sql`insert into table_days (id, table_id, table_name, date, capacity, cutoff_at) values
      ('T1_2026-11-19','T1','Table 1','2026-11-19',9,${cutoff}), ('T2_2026-11-19','T2','Table 2','2026-11-19',2,${cutoff}),
      ('T1_2026-11-24','T1','Table 1','2026-11-24',9,${new Date(muToInstant("2026-11-24", "21:00"))})`;
  });

  it("reserves a place, one per date, not before the weekly opening", async () => {
    const p1 = w.fakes.callerFor([...w.fakes.users.entries()].find(([, u]) => u.app_metadata.player_id === "001")![0]);
    await w.call(p1, "reserveCashPlace", { tableDayId: "T1_2026-11-19" });
    expect(await w.code(p1, "reserveCashPlace", { tableDayId: "T2_2026-11-19" })).toBe("ALREADY_RESERVED_THIS_DATE");
    expect(await w.code(p1, "reserveCashPlace", { tableDayId: "T1_2026-11-24" })).toBe("NOT_OPEN_YET");
  });

  it("never overbooks, even with 20 players reserving the same table at the same moment", async () => {
    await db.sql`insert into table_days (id, table_id, table_name, date, capacity, cutoff_at) values ('T1_2026-11-20','T1','Table 1','2026-11-20',9,${new Date(muToInstant("2026-11-20", "21:00"))})`;
    for (let i = 0; i < 20; i++) {
      const id = String(100 + i);
      await db.sql`insert into players (player_id, seq, surname, first_names, phone_e164, date_of_birth, id_doc_type, id_doc_number_hash)
        values (${id}, ${1000 + i}, 'LOAD', 'Test', ${`+2305800${String(i).padStart(4, "0")}`}, '1990-01-01', 'passport', ${`h${i}`})`;
    }
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => w.code(cashier, "reserveCashPlace", { tableDayId: "T1_2026-11-20", playerId: String(100 + i) })));
    expect(results.filter((r) => r === "OK").length).toBe(9);
    expect(results.filter((r) => r !== "OK").every((r) => r === "TABLE_FULL")).toBe(true);
    const [t] = await db.sql`select active_count from table_days where id = 'T1_2026-11-20'`;
    expect(t!.active_count).toBe(9);
  });

  it("place-available alarm: offer on cancellation, expiry moves to the next player, acceptance books", async () => {
    // Table 2 (capacity 2) is filled by players 100 and 101.
    await w.call(cashier, "reserveCashPlace", { tableDayId: "T2_2026-11-19", playerId: "100" });
    const [r101] = await db.sql`select 1`;
    void r101;
    const res101 = await w.call(cashier, "reserveCashPlace", { tableDayId: "T2_2026-11-19", playerId: "101" });
    expect(await w.code(cashier, "reserveCashPlace", { tableDayId: "T2_2026-11-19", playerId: "002" })).toBe("TABLE_FULL");
    // players 002 then 003 join the waiting list
    const p2 = w.fakes.callerFor([...w.fakes.users.entries()].find(([, u]) => u.app_metadata.player_id === "002")![0]);
    await db.sql`insert into player_devices (token, player_id) values ('fcm-token-002', '002')`;
    await w.call(p2, "joinWaitingList", { tableDayId: "T2_2026-11-19" });
    expect(await w.code(p2, "joinWaitingList", { tableDayId: "T2_2026-11-19" })).toBe("ALREADY_WAITING");
    w.clock += 1000;
    await w.call(cashier, "joinWaitingList", { tableDayId: "T2_2026-11-19", playerId: "003" });

    // a place is released → 002 gets the offer and an alarm
    await w.call(cashier, "cancelCashReservation", { reservationId: res101.reservationId });
    const [offer] = await db.sql`select * from waiting_offers where player_id = '002' and status = 'pending'`;
    expect(offer).toBeTruthy();
    expect(w.fakes.pushes.at(-1)!.msg.title).toBe("TI VEGAS — PLACE AVAILABLE!");
    // nobody else can grab the held place
    expect(await w.code(cashier, "reserveCashPlace", { tableDayId: "T2_2026-11-19", playerId: "105" })).toBe("TABLE_FULL");

    // 002 does not answer within 5 minutes → expiry → 003 gets the next offer
    w.clock += 5 * 60_000;
    expect(await w.code(p2, "respondPlaceOffer", { offerId: offer!.id, action: "accept" })).toBe("EXPIRED");
    const tick = await w.call(null, "cronTick", {}, { cronAuthorized: true });
    expect(tick).toMatchObject({ expiredOffers: 1, newOffers: 1 });
    expect(await w.code(null, "cronTick")).toBe("PERMISSION_DENIED");
    const [o3] = await db.sql`select * from waiting_offers where player_id = '003' and status = 'pending'`;
    const p3 = w.fakes.callerFor([...w.fakes.users.entries()].find(([, u]) => u.app_metadata.player_id === "003")![0]);
    expect(await w.code(p2, "respondPlaceOffer", { offerId: o3!.id, action: "accept" })).toBe("WRONG_PLAYER");
    const acc = await w.call(p3, "respondPlaceOffer", { offerId: o3!.id, action: "accept" });
    expect(acc.status).toBe("accepted");
    const [t] = await db.sql`select active_count, held_count from table_days where id = 'T2_2026-11-19'`;
    expect(t).toMatchObject({ active_count: 2, held_count: 0 });
  });

  it("expires un-checked-in reservations at the cut-off", async () => {
    w.clock = muToInstant("2026-11-19", "21:00");
    const r = await w.call(null, "cronTick", {}, { cronAuthorized: true });
    expect(r.expiredReservations).toBeGreaterThanOrEqual(3);
    const [t] = await db.sql`select active_count from table_days where id = 'T1_2026-11-19'`;
    expect(t!.active_count).toBe(0);
    w.clock = Date.parse("2026-11-16T08:00:00Z");
  });
});

describe("tournament payments, tickets and chips", () => {
  const start = Date.parse("2026-12-01T10:00:00Z");
  beforeAll(async () => {
    await db.sql`insert into tournaments (id, name, config) values ('ME', 'Main Event', ${db.sql.json({
      formats: ["reentry"], buyInCents: 500000, startingChips: 30000, startAt: new Date(start).toISOString(),
      lateRegCloseAt: new Date(start + 3 * 3600_000).toISOString(), maxEntries: 200, reentry: { maxPerPlayer: 2 },
      bonus: { priceCents: 50000, chips: 5000, availableWith: ["buy_in"] },
    })})`;
  });

  it("requires a verified identity and an open shift", async () => {
    expect(await w.code(cashier, "recordTournamentPayment", { tournamentId: "ME", playerId: "002", kind: "buy_in", idempotencyKey: "k".repeat(20) })).toBe("ID_NOT_VERIFIED");
    expect(await w.code(cashier, "recordTournamentPayment", { tournamentId: "ME", playerId: "001", kind: "buy_in", idempotencyKey: "k".repeat(20) })).toBe("NO_SHIFT");
    await db.sql`insert into cashier_shifts (cashier_id, status, opening_float_cents) values (${cashier.uid}, 'open', 1000000)`;
  });

  let tokens: string[] = [];
  it("takes buy-in + bonus once, even if the cashier clicks twice", async () => {
    const key = "payment-key-0000000001";
    const [a, b] = await Promise.all([
      w.call(cashier, "recordTournamentPayment", { tournamentId: "ME", playerId: "001", kind: "buy_in", withBonus: true, idempotencyKey: key }),
      w.call(cashier, "recordTournamentPayment", { tournamentId: "ME", playerId: "001", kind: "buy_in", withBonus: true, idempotencyKey: key }),
    ]);
    expect(a.totalCents).toBe(550000);
    expect(a.totalChips).toBe(35000);
    expect(b.tickets.map((t: any) => t.token)).toEqual(a.tickets.map((t: any) => t.token));
    const ledger = await db.sql`select type, amount_cents from ledger where player_id = '001' order by amount_cents desc`;
    expect(ledger.map((l) => [l.type, Number(l.amount_cents)])).toEqual([["tournament_buy_in", 500000], ["bonus", 50000]]);
    tokens = a.tickets.map((t: any) => t.token);
    expect(await w.code(cashier, "recordTournamentPayment", { tournamentId: "ME", playerId: "001", kind: "buy_in", idempotencyKey: "another-key-000000001" })).toBe("ALREADY_ENTERED");
  });

  it("floor scans: valid once, then ALREADY VALIDATED; forged codes are refused", async () => {
    const floor = admin; // super admin can do floor work
    const v = await w.call(floor, "validateTicket", { code: tokens[0] });
    expect(v).toMatchObject({ screen: "VALID", chips: 30000, player: { id: "001" } });
    const results = await Promise.all([w.call(floor, "confirmChipDelivery", { code: tokens[0] }), w.call(floor, "confirmChipDelivery", { code: tokens[0] })].map((p) => p.catch((e) => ({ screen: e.message }))));
    expect(results.filter((r: any) => r.screen === "VALID").length).toBe(1);
    expect((await w.call(floor, "confirmChipDelivery", { code: tokens[0] })).screen).toBe("ALREADY VALIDATED");
    const forged = tokens[1]!.slice(0, -1) + (tokens[1]!.endsWith("0") ? "1" : "0");
    expect((await w.call(floor, "validateTicket", { code: forged })).screen).toBe("INVALID OR UNPAID TICKET");
    const [t] = await db.sql`select entered, chip_deliveries, pending_chip_deliveries, revenue_cents from tournaments where id = 'ME'`;
    expect(t).toMatchObject({ entered: 1, chip_deliveries: 1, pending_chip_deliveries: 1 });
    expect(Number(t!.revenue_cents)).toBe(550000);
  });
});

describe("database protections", () => {
  it("ledger lines can never be edited or deleted", async () => {
    await expect(db.sql`update ledger set amount_cents = 1`).rejects.toThrow(/cannot be changed/);
    await expect(db.sql`delete from ledger`).rejects.toThrow(/cannot be deleted/);
  });

  it("apps only see what their role allows (row level security)", async () => {
    const asUser = async (claims: object, q: string) =>
      db.sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        return tx.unsafe(q);
      });
    const player = { sub: "00000000-0000-0000-0000-000000000001", app_metadata: { role: "player", player_id: "002" } };
    expect((await asUser(player, "select player_id from players")).map((r) => r.player_id)).toEqual(["002"]);
    expect((await asUser(player, "select * from player_identity")).length).toBe(0);
    expect((await asUser(player, "select * from ledger")).length).toBe(0);
    expect((await asUser(player, "select * from otp_challenges")).length).toBe(0);
    const cash = { sub: cashier.uid, app_metadata: { role: "cashier" } };
    expect((await asUser(cash, "select * from players")).length).toBeGreaterThan(20);
    expect((await asUser(cash, "select * from audit_logs")).length).toBe(0);
    await expect(asUser(player, "insert into ledger (player_id, type, amount_cents, direction, method) values ('002','refund',1,'out','cash')")).rejects.toThrow();
  });
});

describe("integrations", () => {
  it("only the Super Administrator can save WhatsApp keys, and nobody can read them back", async () => {
    expect(await w.code(cashier, "setIntegrations", { whatsapp_token: "x" })).toBe("PERMISSION_DENIED");
    await w.call(admin, "setIntegrations", { whatsapp_token: "EAAG-secret", whatsapp_phone_number_id: "1234567890" });
    const st = await w.call(admin, "getIntegrationStatus");
    expect(st).toMatchObject({ whatsapp: true, push: false });
    expect(JSON.stringify(st)).not.toContain("EAAG-secret");
  });
});

describe("code from the cashier (no WhatsApp)", () => {
  it("gives the code at the desk when WhatsApp is not set up", async () => {
    w.fakes.whatsappConfigured = false;
    w.clock += 120_000;
    const before = w.fakes.sentCodes.length;
    const r = await w.call(null, "requestOtp", { phone: "5799 1111" });
    expect(r).toMatchObject({ delivery: "desk", phone: "+23057991111" });
    expect(w.fakes.sentCodes.length).toBe(before); // nothing sent by WhatsApp
    // players and unapproved callers cannot see desk codes
    expect(await w.code(null, "listDeskCodes")).toBe("UNAUTHENTICATED");
    const list = await w.call(cashier, "listDeskCodes", { query: "57991111" });
    expect(list.codes).toHaveLength(1);
    const code = list.codes[0].code as string;
    expect(code).toMatch(/^\d{6}$/);
    const v = await w.call(null, "verifyOtpCode", { phone: "57991111", code });
    expect(v.email).toMatch(/@players\.tivbook\.app$/);
    // once used, it disappears from the desk list
    expect((await w.call(cashier, "listDeskCodes", { query: "57991111" })).codes).toHaveLength(0);
  });

  it("falls back to the desk if WhatsApp sending fails", async () => {
    w.fakes.whatsappConfigured = true;
    w.fakes.whatsappDown = true;
    w.clock += 120_000;
    const r = await w.call(null, "requestOtp", { phone: "5799 2222" });
    expect(r).toMatchObject({ delivery: "desk", whatsappFailed: true });
    expect((await w.call(cashier, "listDeskCodes", { query: "57992222" })).codes).toHaveLength(1);
    w.fakes.whatsappDown = false;
  });
});

describe("tables, check-in, seating and waiting list (Phase 3)", () => {
  it("manager creates a table; its days appear for the next two weeks", async () => {
    w.clock = Date.parse("2026-11-16T08:00:00Z"); // Monday 12:00 Mauritius
    expect(await w.code(cashier, "upsertCashTable", { name: "X", minBuyInCents: 1, maxBuyInCents: 2 })).toBe("PERMISSION_DENIED");
    const r = await w.call(admin, "upsertCashTable", {
      name: "Table 7", gameType: "NLH", smallBlindCents: 2500, bigBlindCents: 5000, minBuyInCents: 200000, maxBuyInCents: 1000000,
      defaultCapacity: 9, openTime: "19:00", cutoffTime: "21:00", weekdays: [4, 5, 6],
    });
    expect(r.tableId).toBe("TABLE-7");
    const days = await db.sql`select date from table_days where table_id = 'TABLE-7' order by date`;
    expect(days.map((x) => (x.date as Date).toISOString().slice(0, 10))).toEqual(["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-26", "2026-11-27", "2026-11-28"]);
    expect(await w.code(admin, "upsertCashTable", { name: "Bad", minBuyInCents: 500, maxBuyInCents: 100 })).toBe("INVALID_ARGUMENT");
  });

  it("check-in, seats (one player per seat), leaving frees the place for the waiting list", async () => {
    const dayId = "TABLE-7_2026-11-19";
    await w.call(admin, "setTableDay", { tableDayId: dayId, capacity: 6 });
    const a = await w.call(cashier, "reserveCashPlace", { tableDayId: dayId, playerId: "110" });
    const b = await w.call(cashier, "reserveCashPlace", { tableDayId: dayId, playerId: "111" });
    const wl = await w.call(cashier, "joinWaitingList", { tableDayId: dayId, playerId: "112" });
    await w.call(cashier, "checkInReservation", { reservationId: a.reservationId });
    expect(await w.code(cashier, "checkInReservation", { reservationId: a.reservationId })).toBe("NOT_RESERVED");
    await w.call(admin, "seatPlayer", { reservationId: a.reservationId, seat: 3 });
    expect(await w.code(admin, "seatPlayer", { reservationId: b.reservationId, seat: 3 })).toBe("SEAT_TAKEN");
    expect(await w.code(admin, "seatPlayer", { reservationId: b.reservationId, seat: 10 })).toBe("INVALID_SEAT");
    await w.call(admin, "seatPlayer", { reservationId: b.reservationId, seat: 5 });
    // a cut-off never expires seated players
    expect(await w.code(admin, "setTableDay", { tableDayId: dayId, capacity: 1 })).toBe("CAPACITY");
    const left = await w.call(admin, "leaveTable", { reservationId: a.reservationId });
    expect(left.offersCreated).toBe(1);
    const [o] = await db.sql`select * from waiting_offers where waiting_entry_id = ${wl.waitingEntryId}`;
    expect(o!.status).toBe("pending");
  });

  it("a player can leave the waiting list; a held place goes to the next player", async () => {
    const dayId = "TABLE-7_2026-11-19";
    await w.call(cashier, "joinWaitingList", { tableDayId: dayId, playerId: "113" });
    const [entry112] = await db.sql`select id from waiting_lists where player_id = '112' and table_day_id = ${dayId}`;
    await w.call(cashier, "leaveWaitingList", { waitingEntryId: entry112!.id }); // 112 had the pending offer
    const [o113] = await db.sql`select status from waiting_offers where player_id = '113' and table_day_id = ${dayId}`;
    expect(o113!.status).toBe("pending");
    const [t] = await db.sql`select active_count, held_count, waiting_count from table_days where id = ${dayId}`;
    expect(t).toMatchObject({ active_count: 1, held_count: 1, waiting_count: 1 });
  });

  it("shows players their place in the queue", async () => {
    const dayId = "TABLE-7_2026-11-26";
    await w.call(admin, "setTableDay", { tableDayId: dayId, capacity: 2 });
    for (const p of ["114", "115"]) await w.call(cashier, "reserveCashPlace", { tableDayId: dayId, playerId: p });
    const p2 = w.fakes.callerFor([...w.fakes.users.entries()].find(([, u]) => u.app_metadata.player_id === "002")![0]);
    await w.call(cashier, "joinWaitingList", { tableDayId: dayId, playerId: "116" });
    w.clock += 1000;
    const mine = await w.call(p2, "joinWaitingList", { tableDayId: dayId });
    const pos = await w.call(p2, "myWaitingPositions");
    expect(pos.positions[mine.waitingEntryId]).toBe(2);
  });

  it("closed dates in the calendar close the tables of that day", async () => {
    const cal = await w.call(admin, "setBookingCalendar", { openWeekday: 0, openTime: "10:00", closedDates: ["2026-11-21"] });
    expect(cal.closedDates).toEqual(["2026-11-21"]);
    const [t] = await db.sql`select status from table_days where id = 'TABLE-7_2026-11-21'`;
    expect(t!.status).toBe("closed");
  });
});
