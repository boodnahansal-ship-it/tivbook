# TiVBook by Ti Vegas

Poker operations platform for Ti Vegas (Funworld Co Ltd), Grand Baie.
Full design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Two deliverables

- **TiVBook Staff**: one Windows setup with all staff software (or online in a browser)
- **TiVBook player app**: separate download for players' phones

Both sync live through one online backend. **Installation: see [`docs/SETUP.md`](docs/SETUP.md).**

## Status

| Phase | Content | State |
|---|---|---|
| 1 | Architecture, rules engine (money, reservations, waiting lists, movements, tournaments, tickets, tax, ledger) | Done, tested |
| 2 | Player registration, WhatsApp OTP, ID photo upload, sequential IDs, identity verification, staff accounts, device approval, player search; staff software + player app first screens; one-command setup; automatic installer builds | **Done.** Code builds and unit tests pass; not yet run against a live Firebase project |
| 3+ | Cash tables & calendar, waiting-list alarms, tournaments, cashier, printing, floor… | Next |

## For developers

```bash
npm install
npm test             # 59 rule tests
npm run typecheck
npm run build        # staff + player web builds
npm run dev -w @tivbook/staff     # http://localhost:5173
npm run dev -w @tivbook/player    # http://localhost:5174
```

Local backend: `cd backend && firebase emulators:start --project demo-tivbook` with `VITE_USE_EMULATORS=true` in `.env`
(in the emulator only, OTP codes are printed in the functions log instead of being sent by WhatsApp).
