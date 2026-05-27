# Tasks — gr-client-balance-sync

Hybrid debtor-scoped strategy (batch baseline + on-demand TTL refresh). Additive schema, no destructive DDL. STRICT TDD: failing test first, then implementation. Never mock Prisma — use the in-memory ports.

## Phase 0 — Recon (no code change)

- [ ] 0.1 Capture ONE real GR `cliente` response for a known debtor: `{"action":"cliente","cliente_id":<id>}` (use the daily MD5 auth `CUIT+SECRET+YYYY-MM-DD`). Record the exact JSON keys for the debt total, currency, and payment URLs. ✅ **GATE: parser is written against this sample.**
- [ ] 0.2 Confirm where `SyncGestionRealClients` is triggered (cron / route / boot). The new `RefreshDebtorBalances` job hosts there. Record the mechanism.
- [ ] 0.3 Confirm the AR number/locale format of the amount in the captured payload (`"1.234,56"` vs numeric).

## Phase 1 — Schema (additive) — depends on Phase 0

- [ ] 1.1 Edit `prisma/schema.prisma`: add `balanceDue Decimal?`, `balanceCurrency String?`, `lastBalanceAt DateTime?` to `Client`.
- [ ] 1.2 Generate migration via `npm run prisma:migrate` (`<ts>_client_balance_fields`). Confirm SQL matches design.md (3 nullable ADD COLUMNs). `prisma migrate diff` clean.
- [ ] 1.3 Regenerate Prisma client; `tsc --noEmit` green. No behavior change yet. ✅ **DEPLOY GATE (safe — additive).**

## Phase 2 — GR adapter: fetch a single balance — depends on Phase 1

- [ ] 2.1 (TEST) Unit test `parseClientBalanceResponse` against the Phase-0 sample: correct amount; AR format `"1.234,56"`→`1234.56`; no-debt→`{amount:0}`; missing keys→`0` defensively; payment URLs extracted.
- [ ] 2.2 Add `GrClientBalance` interface to `src/domain/entities/gestionReal.ts`.
- [ ] 2.3 Add `fetchClientBalance(grClienteId)` to `GestionRealPort` (`src/domain/ports/GestionRealPort.ts`).
- [ ] 2.4 Implement `fetchClientBalance` + exported pure `parseClientBalanceResponse` in `GestionRealClient.ts` (POST `{action:'cliente', cliente_id:Number(id)}`, same `auth()`).
- [ ] 2.5 `npm test` green for 2.1. `tsc --noEmit` green.

## Phase 3 — Mirror write side — depends on Phase 1

- [ ] 3.1 (TEST) `InMemoryClientMirrorRepository`: `updateClientBalance` sets amount/currency/`lastBalanceAt` and leaves `customAttributes`/status untouched.
- [ ] 3.2 Add `updateClientBalance(grClienteId, amount, currency, at)` to `ClientMirrorRepository` port.
- [ ] 3.3 Implement in `InMemoryClientMirrorRepository.ts`.
- [ ] 3.4 (TEST) Prisma mapper/integration test: `updateClientBalance` writes only the 3 balance columns by `grClienteId`.
- [ ] 3.5 Implement in `PrismaClientMirrorRepository.ts` (`prisma.client.update` selecting only the balance fields; do NOT touch `customAttributes`).
- [ ] 3.6 `npm test` + `tsc --noEmit` green.

## Phase 4 — Batch refresh use case (debtors only) — depends on Phase 2 + 3

- [ ] 4.1 (TEST) `RefreshDebtorBalances` use case (in-memory ports): enumerates ONLY `estado=2` via `fetchClients`, calls `fetchClientBalance` per debtor, upserts balances; asserts a NON-debtor is never fetched.
- [ ] 4.2 (TEST) One GR failure mid-loop skips that debtor and continues (run does not abort); wholesale failure records `error:` in sync-state like `SyncGestionRealClients`.
- [ ] 4.3 Implement `src/application/use-cases/RefreshDebtorBalances.ts` (inject `GestionRealPort`, `ClientMirrorRepository`, `SyncStateRepository`; entity key e.g. `gr-debtor-balances`).
- [ ] 4.4 Wire the periodic job at the mechanism found in Phase 0.2 (interval from config, idempotent).
- [ ] 4.5 `npm test` + `tsc --noEmit` green. ✅ **DEPLOY GATE: batch baseline live, touches ~167 not 5589.**

## Phase 5 — Read path: DTO + on-demand stale refresh — depends on Phase 1–4

- [ ] 5.1 (TEST) `toCustomer` mapper: `Decimal balanceDue` → number (no float drift, reuse `toInvoice` pattern); `balanceStale` derivation (debtor + null/old `lastBalanceAt` → true); non-debtor → `balanceDue:0`, `balanceStale:false`.
- [ ] 5.2 Add `balanceDue`, `balanceCurrency`, `lastBalanceAt`, `balanceStale` to `Customer` entity (`src/domain/entities/customer.ts`).
- [ ] 5.3 Map the fields in `toCustomer` (`PrismaCustomerRepository.ts`) — `Decimal.toNumber()`, ISO date, derived `balanceStale` using `BALANCE_STALE_TTL_MINUTES`.
- [ ] 5.4 (TEST) On-demand refresh: stale debtor detail → live `fetchClientBalance` updates the row then returns fresh; GR timeout/error → stored value + `balanceStale:true`, endpoint stays 200.
- [ ] 5.5 Implement the on-demand branch: small `RefreshClientBalanceIfStale` collaborator (depends on `GestionRealPort` + `ClientMirrorRepository`) invoked by `GetClientDetail`, with `BALANCE_REFRESH_TIMEOUT_MS` short timeout + fallback. Keep `GetClientDetail` DIP-clean (no adapter/Prisma import).
- [ ] 5.6 (TEST) supertest `GET /api/clients/:id`: debtor returns balance fields; GR down → 200 with `balanceStale:true`.
- [ ] 5.7 Wire new collaborator/use cases in `app.ts` ⚠ (surgical block). Add `BALANCE_STALE_TTL_MINUTES` + `BALANCE_REFRESH_TIMEOUT_MS` to `config.ts` + `env.example`.
- [ ] 5.8 `npm test` + `tsc --noEmit` green. ✅ **DEPLOY GATE.**

## Phase 6 — Frontend (sibling repo — lockstep with Phase 5)

- [ ] 6.1 (FE) Add `balanceDue`, `balanceCurrency`, `lastBalanceAt`, `balanceStale` to the client type.
- [ ] 6.2 (FE) Render "Saldo deudor: $X" + currency on the info page for debtors; "Sin deuda" / hidden for non-debtors.
- [ ] 6.3 (FE) Freshness indicator from `lastBalanceAt`/`balanceStale` ("actualizado hace…" vs "sin confirmar").
- [ ] 6.4 (FE) `tsc` + tests green.

## Verification Checklist

- [ ] V.1 A real debtor's info page shows the correct amount from GR `cliente` (verified vs one real client).
- [ ] V.2 Batch run touches only debtors (~167), never the full 5589 (assert call count in the use-case test).
- [ ] V.3 `GET /api/clients/:id` never 500s when GR is down — returns stored balance + `balanceStale:true`.
- [ ] V.4 Non-debtors: `balanceDue:0`, `balanceStale:false`, zero GR calls.
- [ ] V.5 `customAttributes` is NOT clobbered by balance writes (catalog sync and balance refresh coexist).
- [ ] V.6 `npm test` + `tsc --noEmit` green; no use case imports Prisma/adapter (DIP).
