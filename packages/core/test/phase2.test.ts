import { describe, expect, it } from "vitest";
import {
  OTP_POLICY, canSendOtp, generateOtp, hashOtp, normalizePhone, verifyOtp,
  sniffImageType, missingImages, ageOn, isValidLegalName,
} from "../src/index.js";

const PEPPER = "p".repeat(40);

describe("phone numbers", () => {
  it("normalises Mauritius and international numbers", () => {
    expect(normalizePhone("5712 3456")).toBe("+23057123456");
    expect(normalizePhone("+33 6 12 34 56 78")).toBe("+33612345678");
    expect(normalizePhone("0033612345678")).toBe("+33612345678");
    expect(normalizePhone("12")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("WhatsApp OTP", () => {
  const now = 1_000_000_000;
  it("generates 6-digit codes", () => {
    for (let i = 0; i < 50; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });
  it("verifies the right code only, within time and attempts", () => {
    const ch = { codeHash: hashOtp("123456", "+23057123456", PEPPER), createdAt: now, expiresAt: now + OTP_POLICY.ttlMs, attempts: 0, consumed: false };
    expect(verifyOtp(ch, "123 456", "+23057123456", PEPPER, now + 1000)).toEqual({ ok: true });
    expect(verifyOtp(ch, "654321", "+23057123456", PEPPER, now)).toMatchObject({ ok: false, code: "WRONG_CODE", attemptsLeft: 4 });
    expect(verifyOtp(ch, "123456", "+23057000000", PEPPER, now)).toMatchObject({ ok: false, code: "WRONG_CODE" });
    expect(verifyOtp(ch, "123456", "+23057123456", PEPPER, ch.expiresAt)).toMatchObject({ code: "EXPIRED" });
    expect(verifyOtp({ ...ch, attempts: 5 }, "123456", "+23057123456", PEPPER, now)).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
    expect(verifyOtp({ ...ch, consumed: true }, "123456", "+23057123456", PEPPER, now)).toMatchObject({ code: "ALREADY_USED" });
    expect(verifyOtp(null, "123456", "+23057123456", PEPPER, now)).toMatchObject({ code: "NO_CHALLENGE" });
  });
  it("limits resends and abuse", () => {
    expect(canSendOtp({ phoneSends: [], ipSends: [] }, now)).toEqual({ ok: true });
    expect(canSendOtp({ phoneSends: [now - 10_000], ipSends: [] }, now)).toMatchObject({ ok: false, code: "COOLDOWN" });
    expect(canSendOtp({ phoneSends: [now - 300_000, now - 200_000, now - 100_000], ipSends: [] }, now)).toMatchObject({ code: "TOO_MANY_FOR_PHONE" });
    expect(canSendOtp({ phoneSends: [now - 2 * 3600_000], ipSends: [] }, now)).toEqual({ ok: true });
    expect(canSendOtp({ phoneSends: [], ipSends: Array(10).fill(now - 60_000) }, now)).toMatchObject({ code: "TOO_MANY_FROM_IP" });
  });
});

describe("identity documents", () => {
  it("detects image types from content", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    const heic = new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftypheic")]);
    expect(sniffImageType(heic)).toBe("image/heic");
    expect(sniffImageType(new Uint8Array(Buffer.from("%PDF-1.4")))).toBeNull();
  });
  it("lists missing images per document type", () => {
    expect(missingImages("national_id", ["id_front"])).toEqual(["id_back"]);
    expect(missingImages("passport", ["passport"])).toEqual([]);
  });
  it("computes age on a date", () => {
    expect(ageOn("2008-11-14", "2026-11-13")).toBe(17);
    expect(ageOn("2008-11-13", "2026-11-13")).toBe(18);
  });
  it("validates legal names", () => {
    expect(isValidLegalName("Marie-Hélène")).toBe(true);
    expect(isValidLegalName("D'Arifat")).toBe(true);
    expect(isValidLegalName("J0hn")).toBe(false);
  });
});
