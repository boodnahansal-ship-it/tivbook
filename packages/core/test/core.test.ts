import { describe, expect, it } from "vitest";
import {
  // money
  parseRupees, formatRupees, percentOf, sum,
  // ids
  formatPlayerId, parsePlayerId, normalizePlayerIdQuery, buildSearchTokens,
  // time & calendar
  muToInstant, instantToMuDate, weekday, DEFAULT_CALENDAR, bookingOpensAt, openBookingDates,
  // reservations
  checkReservation, shouldExpireAtCutoff, changeCapacity, placesAvailable, type TableDayState,
  // waiting list & offers
  orderQueue, selectNext, queuePositions, type WaitingEntry,
  respondToOffer, newOfferTimes, isOverdue, extendOffer, placeAvailableMessage, type Offer,
  // movement
  evaluateMovement, classify, totalBuyIn, canTransitionMovement,
  // tournaments
  computeCharge, canTransitionEntry, countdown, type TournamentConfig,
  // tickets
  issueTicketToken, verifyTicketToken, tokenForTicketId, scanOutcome, hashToken,
  // tax & payouts
  calculatePrizeTax, DEFAULT_PRIZE_TAX_RULE, activeRule, planCashInstalments, checkPayout, DEFAULT_DAILY_CASH_CAP_CENTS,
  // ledger
  buildReversal, reconcileShift, spendingSummary, cashEffect, type LedgerTxn,
} from "../src/index.js";

const RS = (n: number) => Math.round(n * 100);

describe("money", () => {
  it("parses and formats rupees exactly", () => {
    expect(parseRupees("1,250.50")).toBe(125050);
    expect(parseRupees("Rs 1250.5")).toBe(125050);
    expect(parseRupees("2000")).toBe(200000);
    expect(() => parseRupees("12.345")).toThrow();
    expect(formatRupees(125050)).toBe("Rs 1,250.50");
    expect(formatRupees(-5)).toBe("-Rs 0.05");
  });
  it("avoids floating point drift", () => {
    expect(sum([10, 20])).toBe(30); // 0.10 + 0.20 is exactly Rs 0.30
    expect(percentOf(RS(150_000), 1000)).toBe(RS(15_000));
    expect(percentOf(5, 1000)).toBe(1); // 0.5 cent rounds half-up
    expect(() => sum([0.1])).toThrow();
  });
});

describe("player IDs", () => {
  it("formats sequential IDs and expands after 999", () => {
    expect(formatPlayerId(1)).toBe("001");
    expect(formatPlayerId(42)).toBe("042");
    expect(formatPlayerId(999)).toBe("999");
    expect(formatPlayerId(1000)).toBe("1000");
    expect(parsePlayerId("007")).toBe(7);
    expect(() => parsePlayerId("0012")).toThrow();
    expect(normalizePlayerIdQuery("7")).toBe("007");
    expect(normalizePlayerIdQuery("Jean")).toBeNull();
  });
  it("builds accent-insensitive search tokens", () => {
    const t = buildSearchTokens({ surname: "Hélène", firstNames: "Marie", phoneE164: "+23057123456" });
    expect(t).toContain("he");
    expect(t).toContain("helene");
    expect(t).toContain("tel:57123456");
  });
});

describe("Mauritius time and weekly calendar", () => {
  it("converts local time with UTC+4", () => {
    expect(new Date(muToInstant("2026-11-15", "10:00")).toISOString()).toBe("2026-11-15T06:00:00.000Z");
    expect(instantToMuDate(Date.parse("2026-11-15T21:00:00Z"))).toBe("2026-11-16");
    expect(weekday("2026-11-15")).toBe(0); // Sunday
  });
  it("opens Mon–Sun on the preceding Sunday at 10:00", () => {
    const opens = bookingOpensAt("2026-11-19", DEFAULT_CALENDAR); // Thursday
    expect(opens).toBe(muToInstant("2026-11-15", "10:00"));
    expect(bookingOpensAt("2026-11-22", DEFAULT_CALENDAR)).toBe(opens); // Sunday same week
    expect(bookingOpensAt("2026-11-23", DEFAULT_CALENDAR)).toBe(muToInstant("2026-11-22", "10:00"));
  });
  it("lists only the opened booking period", () => {
    const beforeOpen = muToInstant("2026-11-15", "09:59");
    expect(openBookingDates("2026-11-15", beforeOpen, DEFAULT_CALENDAR)).toEqual(["2026-11-15"]);
    const afterOpen = muToInstant("2026-11-15", "10:00");
    const dates = openBookingDates("2026-11-15", afterOpen, DEFAULT_CALENDAR);
    expect(dates[0]).toBe("2026-11-15");
    expect(dates.at(-1)).toBe("2026-11-22");
    expect(dates).toHaveLength(8);
  });
  it("respects per-week opening overrides and closed dates", () => {
    const s = { ...DEFAULT_CALENDAR, closedDates: ["2026-11-18"], openingOverrides: { "2026-11-16": { date: "2026-11-14", time: "18:00" } } };
    expect(bookingOpensAt("2026-11-17", s)).toBe(muToInstant("2026-11-14", "18:00"));
    expect(openBookingDates("2026-11-16", muToInstant("2026-11-16", "12:00"), s)).not.toContain("2026-11-18");
  });
});

describe("cash reservations", () => {
  const table = (o: Partial<TableDayState> = {}): TableDayState => ({
    tableId: "T1", date: "2026-11-19", status: "open", capacity: 9, activeCount: 0, heldCount: 0,
    cutoffAt: muToInstant("2026-11-19", "21:00"), ...o,
  });
  const now = muToInstant("2026-11-16", "12:00");
  const base = { nowMs: now, calendar: DEFAULT_CALENDAR, playerHasActiveReservationOnDate: false };

  it("accepts a valid reservation", () => expect(checkReservation({ ...base, table: table() })).toEqual({ ok: true }));
  it("one reservation per player per date", () => {
    const r = checkReservation({ ...base, table: table(), playerHasActiveReservationOnDate: true });
    expect(r.ok === false && r.code).toBe("ALREADY_RESERVED_THIS_DATE");
  });
  it("no overbooking: held offers count", () => {
    const r = checkReservation({ ...base, table: table({ activeCount: 8, heldCount: 1 }) });
    expect(r.ok === false && r.code).toBe("TABLE_FULL");
  });
  it("blocks before opening and after cut-off", () => {
    const early = checkReservation({ ...base, table: table({ date: "2026-11-24", cutoffAt: muToInstant("2026-11-24", "21:00") }) });
    expect(early.ok === false && early.code).toBe("NOT_OPEN_YET");
    const late = checkReservation({ ...base, nowMs: muToInstant("2026-11-19", "21:00"), table: table() });
    expect(late.ok === false && late.code).toBe("PAST_CUTOFF");
  });
  it("expires only un-checked-in reservations", () => {
    const cut = 1000;
    expect(shouldExpireAtCutoff("reserved", cut, 1000)).toBe(true);
    expect(shouldExpireAtCutoff("checked_in", cut, 5000)).toBe(false);
    expect(shouldExpireAtCutoff("reserved", cut, 999)).toBe(false);
  });
  it("capacity changes release places and never go below occupancy", () => {
    const t = table({ activeCount: 9 });
    expect(placesAvailable(t)).toBe(0);
    expect(changeCapacity(t, 10)).toEqual({ ok: true, released: 1 });
    expect(changeCapacity(t, 8).ok).toBe(false);
  });
});

describe("waiting lists", () => {
  const e = (id: string, type: WaitingEntry["listType"], at: number, extra: Partial<WaitingEntry> = {}): WaitingEntry => ({
    id, playerId: `P${id}`, listType: type, requestedAt: at, status: "waiting", ...extra,
  });
  const list = [e("a", "new_player", 1), e("b", "movement", 2), e("c", "new_player", 3), e("d", "movement", 4), e("x", "new_player", 0, { status: "expired" })];

  it("FIFO ignores non-waiting entries", () => expect(orderQueue(list, "fifo").map((x) => x.id)).toEqual(["a", "b", "c", "d"]));
  it("existing-player priority", () => expect(orderQueue(list, "existing_first").map((x) => x.id)).toEqual(["b", "d", "a", "c"]));
  it("new-player priority", () => expect(orderQueue(list, "new_first").map((x) => x.id)).toEqual(["a", "c", "b", "d"]));
  it("alternating continues from last served type", () => {
    expect(orderQueue(list, "alternating", "new_player").map((x) => x.id)).toEqual(["b", "a", "d", "c"]);
  });
  it("manual priority overrides time", () => {
    const m = [e("a", "new_player", 1), e("b", "new_player", 2, { priorityOverride: 1 })];
    expect(orderQueue(m, "manual").map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("skips ineligible players", () => {
    expect(selectNext(list, "fifo", (x) => x.id !== "a")?.id).toBe("b");
    expect(queuePositions(list, "fifo").get("c")).toBe(3);
  });
});

describe("place-available offers", () => {
  const t0 = 1_000_000;
  const offer: Offer = { id: "o1", waitingEntryId: "w1", playerId: "007", tableDayId: "T2", status: "pending", ...newOfferTimes(t0) };
  it("defaults to five minutes of server time", () => expect(offer.expiresAt - offer.createdAt).toBe(300_000));
  it("accepts in time, rejects late or foreign responses", () => {
    expect(respondToOffer(offer, "007", "accept", t0 + 299_999)).toEqual({ ok: true, status: "accepted" });
    expect(respondToOffer(offer, "007", "accept", t0 + 300_000).ok).toBe(false);
    expect(respondToOffer(offer, "008", "accept", t0).ok).toBe(false);
    expect(respondToOffer({ ...offer, status: "accepted" }, "007", "accept", t0).ok).toBe(false);
  });
  it("detects overdue offers and extends deadlines", () => {
    expect(isOverdue(offer, t0 + 300_000)).toBe(true);
    expect(extendOffer(offer, 2, t0)).toBe(offer.expiresAt + 120_000);
  });
  it("uses the specified alert text", () => {
    expect(placeAvailableMessage("new_player", "Table 2")).toEqual({
      title: "TI VEGAS — PLACE AVAILABLE!",
      body: "A place is available at Table 2. Please confirm before your offer expires.",
    });
  });
});

describe("table movement", () => {
  const T25 = { minBuyInCents: RS(2_000), maxBuyInCents: RS(10_000) };
  const T50 = { minBuyInCents: RS(5_000), maxBuyInCents: RS(25_000) };
  const session = (chips: number, buyIns = [RS(5_000)]) => ({
    initialBuyInCents: buyIns[0]!, additionalBuyInsCents: buyIns.slice(1), transferInCents: 0, currentChipValueCents: chips,
  });

  it("classifies using total buy-ins", () => {
    const s = session(RS(9_000), [RS(5_000), RS(3_000)]);
    expect(totalBuyIn(s)).toBe(RS(8_000));
    expect(classify(s)).toBe("winning");
    expect(classify(session(RS(5_000)))).toBe("break_even");
    expect(classify(session(RS(4_000)))).toBe("losing");
  });
  it("winning player may move up", () => {
    const d = evaluateMovement({ session: session(RS(8_000), [RS(3_000)]), from: T25, to: T50, proposedTransferCents: RS(8_000) });
    expect(d.outcome).toBe("allowed");
  });
  it("winning player is restricted from moving down", () => {
    const d = evaluateMovement({ session: session(RS(8_000)), from: T50, to: T25, proposedTransferCents: RS(8_000) });
    expect(d.outcome === "rejected" && d.code).toBe("RESTRICTED_BY_POLICY");
  });
  it("losing player moving down needs approval by default", () => {
    const d = evaluateMovement({ session: session(RS(4_000)), from: T50, to: T25, proposedTransferCents: RS(4_000) });
    expect(d.outcome).toBe("approval");
  });
  it("forbids partial transfers", () => {
    const d = evaluateMovement({ session: session(RS(8_000)), from: T25, to: T50, proposedTransferCents: RS(6_000) });
    expect(d.outcome === "rejected" && d.code).toBe("PARTIAL_TRANSFER");
  });
  it("never trims chips to fit the destination maximum", () => {
    const d = evaluateMovement({ session: session(RS(30_000)), from: T50, to: T50, proposedTransferCents: RS(30_000) });
    expect(d.outcome === "rejected" && d.code).toBe("ABOVE_DESTINATION_MAX");
  });
  it("blocks below destination minimum", () => {
    const d = evaluateMovement({ session: session(RS(1_000), [RS(2_000)]), from: T25, to: T50, proposedTransferCents: RS(1_000) });
    expect(d.outcome === "rejected" && d.code).toBe("BELOW_DESTINATION_MIN");
  });
  it("honours a custom matrix", () => {
    const matrix = {
      winning: { higher: "allowed", equal: "allowed", lower: "restricted" },
      losing: { higher: "restricted", equal: "allowed", lower: "allowed" },
      break_even: { higher: "approval", equal: "approval", lower: "approval" },
    } as const;
    const d = evaluateMovement({ session: session(RS(6_000), [RS(8_000)]), from: T25, to: T50, proposedTransferCents: RS(6_000), matrix });
    expect(d.outcome).toBe("rejected");
  });
  it("enforces the status flow", () => {
    expect(canTransitionMovement("pending_approval", "approved")).toBe(true);
    expect(canTransitionMovement("requested", "completed")).toBe(false);
  });
});

describe("tournaments", () => {
  const now = Date.parse("2026-12-01T10:00:00Z");
  const t: TournamentConfig = {
    id: "ME", formats: ["reentry"], buyInCents: RS(5_000), startingChips: 30_000,
    startAt: now, lateRegCloseAt: now + 3 * 3600_000, maxEntries: 200,
    reentry: { maxPerPlayer: 2 },
    rebuy: null,
    addon: { priceCents: RS(2_000), chips: 20_000, opensAt: now + 2 * 3600_000, closesAt: now + 2.25 * 3600_000, maxPerPlayer: 1 },
    bonus: { priceCents: RS(500), chips: 5_000, availableWith: ["buy_in"] },
  };
  const fresh = { paidEntries: 0, rebuys: 0, addons: 0, hasActiveEntry: false, hasUndeliveredEntry: false };

  it("buy-in + bonus totals price and chips", () => {
    const r = computeCharge(t, "buy_in", fresh, { withBonus: true, nowMs: now, totalEntriesSoFar: 10 });
    expect(r).toMatchObject({ ok: true, totalCents: RS(5_500), totalChips: 35_000 });
  });
  it("re-entry limits and active-entry rule", () => {
    const busted = { ...fresh, paidEntries: 1 };
    expect(computeCharge(t, "reentry", busted, { nowMs: now, totalEntriesSoFar: 10 }).ok).toBe(true);
    expect(computeCharge(t, "reentry", { ...busted, hasActiveEntry: true }, { nowMs: now, totalEntriesSoFar: 10 }).ok).toBe(false);
    expect(computeCharge(t, "reentry", { ...fresh, paidEntries: 3 }, { nowMs: now, totalEntriesSoFar: 10 }).ok).toBe(false);
    expect(computeCharge(t, "reentry", busted, { withBonus: true, nowMs: now, totalEntriesSoFar: 10 }).ok).toBe(false);
  });
  it("late registration, sold-out, add-on window", () => {
    expect(computeCharge(t, "buy_in", fresh, { nowMs: t.lateRegCloseAt, totalEntriesSoFar: 0 }).ok).toBe(false);
    expect(computeCharge(t, "buy_in", fresh, { nowMs: now, totalEntriesSoFar: 200 }).ok).toBe(false);
    const playing = { ...fresh, paidEntries: 1, hasActiveEntry: true };
    expect(computeCharge(t, "addon", playing, { nowMs: now, totalEntriesSoFar: 1 }).ok).toBe(false);
    expect(computeCharge(t, "addon", playing, { nowMs: now + 2 * 3600_000, totalEntriesSoFar: 1 })).toMatchObject({ ok: true, totalChips: 20_000 });
    expect(computeCharge(t, "rebuy", playing, { nowMs: now, totalEntriesSoFar: 1 }).ok).toBe(false);
  });
  it("registration state machine", () => {
    expect(canTransitionEntry("preregistered", "paid")).toBe(true);
    expect(canTransitionEntry("preregistered", "entered")).toBe(false);
    expect(canTransitionEntry("entered", "refunded")).toBe(false);
  });
  it("countdown", () => expect(countdown(now + 90_061_000, now)).toEqual({ done: false, days: 1, hours: 1, minutes: 1, seconds: 1 }));
});

describe("tickets", () => {
  const secret = "x".repeat(40);
  it("issues verifiable tokens without personal data", () => {
    const { ticketId, token, tokenHash } = issueTicketToken(secret);
    expect(token).toMatch(/^TV1\.[0-9A-Z]{26}\.[0-9A-Z]{16}$/);
    expect(verifyTicketToken(token, secret)).toEqual({ ok: true, ticketId, tokenHash });
    expect(tokenForTicketId(ticketId, secret)).toBe(token); // reprint gives identical code
    expect(verifyTicketToken(token.toLowerCase(), secret).ok).toBe(true); // scanner case-insensitive
  });
  it("rejects forged and malformed codes", () => {
    const { token } = issueTicketToken(secret);
    const forged = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(verifyTicketToken(forged, secret)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyTicketToken(token, "y".repeat(40)).ok).toBe(false);
    expect(verifyTicketToken("hello", secret)).toEqual({ ok: false, reason: "MALFORMED" });
  });
  it("floor screens: valid / already validated / invalid", () => {
    const check = { ok: true as const, ticketId: "A", tokenHash: hashToken("a") };
    const ticket = { status: "valid" as const, paid: true, chips: 30_000 };
    expect(scanOutcome({ check, ticket, delivery: null })).toEqual({ screen: "VALID", chips: 30_000 });
    expect(scanOutcome({ check, ticket, delivery: { at: 1, by: "floor1" } }).screen).toBe("ALREADY VALIDATED");
    expect(scanOutcome({ check, ticket: { ...ticket, paid: false }, delivery: null }).screen).toBe("INVALID OR UNPAID TICKET");
    expect(scanOutcome({ check, ticket: null, delivery: null }).screen).toBe("INVALID OR UNPAID TICKET");
  });
});

describe("prize tax and payouts", () => {
  it("no tax up to Rs 100,000", () => {
    expect(calculatePrizeTax(RS(100_000), DEFAULT_PRIZE_TAX_RULE).taxCents).toBe(0);
  });
  it("10% on the whole amount from Rs 100,001", () => {
    const c = calculatePrizeTax(RS(100_001), DEFAULT_PRIZE_TAX_RULE);
    expect(c.taxCents).toBe(RS(10_000.1));
    expect(c.netCents).toBe(RS(90_000.9));
  });
  it("supports excess-only method and authorized overrides", () => {
    const rule = { ...DEFAULT_PRIZE_TAX_RULE, method: "excess_only" as const, exemptCents: RS(100_000) };
    expect(calculatePrizeTax(RS(200_000), rule).taxCents).toBe(RS(10_000));
    expect(() => calculatePrizeTax(RS(200_000), rule, { taxCents: 0, authorizedBy: "", reason: "" })).toThrow();
  });
  it("picks the rule effective at payout time", () => {
    const newer = { ...DEFAULT_PRIZE_TAX_RULE, id: "2027", rateBp: 1500, effectiveFrom: Date.parse("2027-01-01") };
    expect(activeRule([DEFAULT_PRIZE_TAX_RULE, newer], "tournament_prize", Date.parse("2026-12-31"))?.id).toBe(DEFAULT_PRIZE_TAX_RULE.id);
    expect(activeRule([DEFAULT_PRIZE_TAX_RULE, newer], "tournament_prize", Date.parse("2027-02-01"))?.id).toBe("2027");
  });
  it("splits cash payouts over the daily cap", () => {
    expect(planCashInstalments(RS(1_260_000), DEFAULT_DAILY_CASH_CAP_CENTS)).toEqual([RS(500_000), RS(500_000), RS(260_000)]);
    expect(planCashInstalments(RS(100_000), DEFAULT_DAILY_CASH_CAP_CENTS, RS(450_000))).toEqual([RS(50_000), RS(50_000)]);
  });
  it("prevents duplicate and over-cap payouts", () => {
    const base = {
      entitlementNetCents: RS(900_000), alreadyPaidNetCents: 0, requestedCents: RS(500_000), method: "cash" as const,
      dailyCapCents: DEFAULT_DAILY_CASH_CAP_CENTS, paidCashTodayCents: 0, resultsApproved: true, identityVerified: true,
    };
    expect(checkPayout(base).ok).toBe(true);
    expect(checkPayout({ ...base, paidCashTodayCents: 1 }).ok).toBe(false);
    expect(checkPayout({ ...base, alreadyPaidNetCents: RS(900_000) }).ok).toBe(false);
    expect(checkPayout({ ...base, resultsApproved: false }).ok).toBe(false);
  });
});

describe("ledger", () => {
  const tx = (id: string, type: LedgerTxn["type"], amount: number, method: LedgerTxn["method"] = "cash"): LedgerTxn => ({
    id, playerId: "007", type, amountCents: amount, method, cashierId: "c1", shiftId: "s1", createdAt: 0,
  });
  it("transfers are not cash received", () => {
    expect(cashEffect(tx("1", "transfer_in", RS(5_000), "none"))).toBe(0);
    expect(cashEffect(tx("2", "tournament_buy_in", RS(5_000)))).toBe(RS(5_000));
    expect(cashEffect(tx("3", "prize_payout", RS(1_000)))).toBe(-RS(1_000));
  });
  it("reversals undo the drawer effect and cannot be repeated", () => {
    const original = tx("1", "tournament_buy_in", RS(5_000));
    const rev = buildReversal(original, { id: "r1", cashierId: "c1", shiftId: "s1", nowMs: 1, authRef: "MGR-PIN", reason: "wrong event" });
    expect(cashEffect(rev)).toBe(-RS(5_000));
    expect(() => buildReversal({ ...original, reversedByTxnId: "r1" }, { id: "r2", cashierId: "c1", shiftId: "s1", nowMs: 2, authRef: "x", reason: "y" })).toThrow();
    expect(() => buildReversal(original, { id: "r3", cashierId: "c1", shiftId: "s1", nowMs: 2, authRef: "", reason: "y" })).toThrow();
  });
  it("reconciles a shift to the cent", () => {
    const txns = [tx("1", "tournament_buy_in", RS(5_000)), tx("2", "bonus", RS(500)), tx("3", "prize_payout", RS(2_000)), tx("4", "rebuy", RS(1_000), "card")];
    expect(reconcileShift(RS(10_000), txns, RS(13_500))).toEqual({ expectedCents: RS(13_500), declaredCents: RS(13_500), varianceCents: 0 });
  });
  it("spending summary excludes reversed transactions", () => {
    const a = { ...tx("1", "tournament_buy_in", RS(5_000)), reversedByTxnId: "r" };
    const r = { ...tx("r", "reversal", RS(5_000)), reversesTxnId: "1", originalDirection: "in" as const };
    const b = tx("2", "reentry", RS(5_000));
    const s = spendingSummary([a, r, b]);
    expect(s.tournamentBuyInsCents).toBe(0);
    expect(s.reentriesCents).toBe(RS(5_000));
  });
});
