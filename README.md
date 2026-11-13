# TiVBook by Ti Vegas

Poker operations platform for Ti Vegas (Funworld Co Ltd), Grand Baie.

**Install:** see [`docs/SETUP.md`](docs/SETUP.md). **Design:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Two downloads

- **TiVBook-Staff-Setup.exe**: all staff software in one Windows setup, including the one-click online setup wizard.
- **TiVBook-Player.apk**: the player app, a separate download for phones.

Both run on the casino's own **free Supabase** project (no bank card) and sync live.

## Status

| Phase | Content | State |
|---|---|---|
| 1 | Architecture; rules engine (money, reservations, waiting lists, movements, tournaments, tickets, tax, ledger) | Done, 59 tests |
| 2 | Registration, WhatsApp OTP, ID photos, sequential IDs, identity check, staff accounts, device approval, search; Supabase server and database; one-click Windows setup | Done, 18 database/server tests. First live run on Supabase still to come |
| 3+ | Cash tables & calendar screens, waiting-list alarms on phones, tournaments, cashier, printing, floor… | Next |

## For developers

```bash
npm install
npm test                         # rules + server tests (server tests need PostgreSQL: TIVBOOK_TEST_PG=postgres://…)
npm run typecheck
npm run build                    # core, server bundle, staff + player web builds
npm run desktop -w @tivbook/staff        # run the Windows app locally (Electron)
npm run setup:windows -w @tivbook/staff  # build TiVBook-Staff-Setup.exe (on Linux needs wine + wine32)
npm run android -w @tivbook/player       # open the player app in Android Studio
```

`server/build.mjs` bundles the server into one file and embeds it, with `server/sql/schema.sql`, into the staff software. The setup wizard installs both on Supabase.
