#!/usr/bin/env node
/**
 * TiVBook — one-command online setup.
 *
 *   npm run setup
 *
 * Does everything needed to put TiVBook online in the casino's Firebase project:
 * connects the project, writes the app configuration, creates the security keys,
 * deploys the database rules, the backend and the two websites (staff + players),
 * and creates the first Super Administrator account.
 * Safe to run again: steps already done are skipped or simply updated.
 */
import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ROOT = new URL("..", import.meta.url).pathname;
const BACKEND = `${ROOT}backend`;
const FB = "npx -y firebase-tools@13";
const rl = createInterface({ input: stdin, output: stdout });

const say = (m) => console.log(`\n\x1b[33m▶ ${m}\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const ask = async (q, def = "") => (await rl.question(`  ${q}${def ? ` [${def}]` : ""}: `)).trim() || def;
function run(cmd, opts = {}) {
  const r = spawnSync(cmd, { shell: true, stdio: opts.capture ? ["pipe", "pipe", "inherit"] : "inherit", cwd: opts.cwd ?? BACKEND, input: opts.input, encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) { console.error(`\n✗ Failed: ${cmd}`); process.exit(1); }
  return r.stdout ?? "";
}

console.log("\n\x1b[1mTiVBook — online setup\x1b[0m  (about 10 minutes)\n");
console.log("Before starting, you need a Firebase project on the Blaze (pay-as-you-go) plan.");
console.log("Create one at https://console.firebase.google.com, then come back here.\n");

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) { console.error("Node.js 22 or newer is required: https://nodejs.org"); process.exit(1); }

say("1/7  Sign in to Google / Firebase");
run(`${FB} login`, { allowFail: true });

say("2/7  Choose the Firebase project");
const projectId = await ask("Firebase project ID (e.g. tivbook-tivegas)");
if (!projectId) process.exit(1);
writeFileSync(`${BACKEND}/.firebaserc`, JSON.stringify({ projects: { default: projectId } }, null, 2));
ok(`project ${projectId}`);

say("3/7  App configuration");
let sdk = run(`${FB} apps:sdkconfig WEB --project ${projectId} --json`, { capture: true, allowFail: true });
if (!sdk.includes('"apiKey"')) {
  run(`${FB} apps:create WEB "TiVBook" --project ${projectId}`);
  sdk = run(`${FB} apps:sdkconfig WEB --project ${projectId} --json`, { capture: true });
}
const cfg = JSON.parse(sdk).result.sdkConfig;
writeFileSync(`${ROOT}.env`, [
  `VITE_FIREBASE_API_KEY=${cfg.apiKey}`,
  `VITE_FIREBASE_AUTH_DOMAIN=${cfg.authDomain}`,
  `VITE_FIREBASE_PROJECT_ID=${cfg.projectId}`,
  `VITE_FIREBASE_STORAGE_BUCKET=${cfg.storageBucket}`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID=${cfg.messagingSenderId}`,
  `VITE_FIREBASE_APP_ID=${cfg.appId}`,
  "VITE_USE_EMULATORS=false",
  "",
].join("\n"));
ok(".env written");

say("4/7  Security keys and WhatsApp");
const existingSecrets = run(`${FB} functions:secrets:get TICKET_SECRET --project ${projectId}`, { capture: true, allowFail: true });
const setSecret = (name, value) => run(`${FB} functions:secrets:set ${name} --project ${projectId} --data-file - --force`, { input: value, capture: true });
const setupCode = randomBytes(24).toString("hex");
if (!existingSecrets.includes("TICKET_SECRET")) {
  setSecret("TICKET_SECRET", randomBytes(32).toString("hex"));
  setSecret("OTP_PEPPER", randomBytes(32).toString("hex"));
  ok("ticket and OTP keys created");
} else ok("keys already exist (kept)");
setSecret("SETUP_CODE", setupCode);

const waId = await ask("WhatsApp Phone Number ID (leave empty to add later)");
const waToken = waId ? await ask("WhatsApp permanent access token") : "";
setSecret("WHATSAPP_TOKEN", waToken || "not-configured");
writeFileSync(`${BACKEND}/functions/.env.${projectId}`, `WHATSAPP_PHONE_NUMBER_ID=${waId}\nWHATSAPP_TEMPLATE=tivbook_otp\nWHATSAPP_TEMPLATE_LANG=en\n`);
ok(waId ? "WhatsApp configured" : "WhatsApp skipped — players cannot verify phones until it is added (run setup again)");

say("5/7  Websites (staff + players)");
for (const [target, site] of [["staff", `${projectId}-staff`], ["play", `${projectId}-play`]]) {
  run(`${FB} hosting:sites:create ${site} --project ${projectId}`, { allowFail: true, capture: true });
  run(`${FB} target:apply hosting ${target} ${site} --project ${projectId}`, { capture: true });
}
ok("sites ready");

say("6/7  Build and deploy (this takes a few minutes)");
run("npm ci", { cwd: ROOT });
run("npm run build", { cwd: ROOT });
run(`${FB} deploy --project ${projectId} --force`);
ok("TiVBook is online");

say("7/7  First Super Administrator");
const email = await ask("Administrator email");
let password = "";
while (password.length < 10) password = await ask("Administrator password (min. 10 characters)");
const name = await ask("Administrator name", "Super Administrator");
const res = await fetch(`https://europe-west1-${projectId}.cloudfunctions.net/bootstrapSuperAdmin`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ data: { setupCode, email, password, displayName: name } }),
});
const body = await res.json().catch(() => ({}));
if (res.ok) ok(`administrator ${email} created`);
else console.log(`  ! ${body?.error?.message ?? res.status} (an administrator may already exist)`);
setSecret("SETUP_CODE", randomBytes(24).toString("hex")); // invalidate the code
rl.close();

console.log(`
\x1b[1mDone.\x1b[0m

  Staff software (online):  https://${projectId}-staff.web.app
  Player website:           https://${projectId}-play.web.app

  Windows installer and Android app: GitHub → Actions → "Build TiVBook" (see docs/SETUP.md).
  Sign in to the staff software with ${email}. Your computer is approved automatically.
`);
