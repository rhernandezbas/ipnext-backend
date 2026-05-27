# Proposal — gr-client-balance-sync

## Intent

Show the client's REAL outstanding balance (the *monto adeudado*, an amount) on the client info page. Today we only know **whether** a client is a debtor — not **how much**. The GR mirror is built from the `clientes_consulta` action (`GestionRealClient.fetchClients`), whose normalized `GrClient` carries `status`/`statusCode` (estado: 1=Activo, 2=Deudor, …) but **no monetary figure**. The debt amount lives in a different GR action — `cliente` (`{"action":"cliente","cliente_id":N}`) — whose response includes "cuentas con deuda / facturas / URLs de pago". This change brings that amount into the product and surfaces it on `GET /api/clients/:id`.

## Problem

1. **No amount, only a flag.** `parseClientsResponse` (`GestionRealClient.ts:94`) maps `estado.codigo` → `statusCode`, which `mapStatus` (`PrismaClientMirrorRepository.ts:8`) collapses into `ClientStatus` (`late` for deudor). The UI can say "debtor" but cannot say "owes $X".
2. **The amount source is per-client, not bulk.** `clientes_consulta` is paginated (100/page) and used for the whole-catalog mirror sync (`SyncGestionRealClients`). The `cliente` action is **one HTTP request per client** — there is no batch variant that returns balances for many clients at once.
3. **Scale makes naive sync impossible.** With ~5589 clients, calling `cliente` for every client on every sync run = 5589 sequential authenticated POSTs per cycle. That is operationally infeasible and abusive to the GR API. Yet the debtor set — the ONLY clients for whom a balance is interesting — is small (`estado=2`, ~167 clients per the current snapshot).
4. **No place to store the amount.** The `Client` model (`schema.prisma:176`) has no balance field; only `customAttributes Json?` (currently holding the raw `clientes_consulta` payload, NOT the `cliente` payload).
5. **No freshness signal.** Even once stored, the UI must know whether a balance is fresh or stale (GR may be down; debt changes daily after payments).

## Scope IN

- A new GR port method to fetch a single client's balance via the `cliente` action, with a normalized `GrClientBalance` shape (amount + currency + as-of + optional payment URLs).
- Persistence of the balance on the local mirror (decision in `design.md`: dedicated `Client` columns `balanceDue` + `lastBalanceAt`, NOT `customAttributes`).
- A balance refresh use case scoped to **debtors only** (`estado=2`), run as a separate periodic job — decoupled from the full `SyncGestionRealClients` catalog sync.
- A read-time on-demand fallback so opening a debtor's info page can trigger a live refresh when the stored balance is stale (hybrid strategy — see `design.md` AD-2).
- DTO exposure: `balanceDue`, `balanceCurrency`, `lastBalanceAt`, and a derived `balanceStale` flag on the `Customer` DTO returned by `GET /api/clients/:id`.
- Error / staleness handling: GR failures never 500 the client detail; the page shows the last known balance with a staleness indicator.
- Frontend coordination contract (what the info page renders) — implementation tracked in the sibling repo.

## Scope OUT

- Backfilling balances for NON-debtor clients (estado 1/3/4/6). A client who is not a debtor owes nothing → `balanceDue = 0`; no `cliente` call needed.
- Payment processing / charging / redirect to Siro/MercadoPago/PagoFácil/Macro. We may STORE the payment URLs (cheap, already in the payload) but wiring a pay button is a separate change.
- Invoice-level breakdown (per-factura list). This change delivers the aggregate amount; a future change can drill into "cuentas con deuda".
- Changing the existing `clientes_consulta` catalog sync cadence or contract.
- Splynx changes.

## Approach (high level)

**Hybrid, debtor-scoped** (recommended — full justification in `design.md` AD-2):

1. **Schema**: add `balanceDue Decimal?`, `balanceCurrency String?`, `lastBalanceAt DateTime?` to `Client`. Forward-only additive migration; all nullable so the existing 5589-row mirror and fixtures keep working.
2. **GR adapter**: add `fetchClientBalance(grClienteId)` → `GrClientBalance` to `GestionRealPort` + `GestionRealClient`, with a pure `parseClientBalanceResponse` helper (mirrors the existing `parseClientsResponse` style).
3. **Batch refresh (primary path)**: a `RefreshDebtorBalances` use case that pages `clientes_consulta` with `estado=2` to enumerate the small debtor set, then calls `fetchClientBalance` per debtor and upserts `balanceDue`/`lastBalanceAt` via a new mirror port method. Run on a periodic job (e.g. hourly/daily) — bounded to ~167 calls, not ~5589.
4. **On-demand refresh (freshness path)**: when `GET /api/clients/:id` is hit for a debtor whose `lastBalanceAt` is older than a TTL (e.g. 1h), trigger a single live `fetchClientBalance` and update the row before responding (with a short timeout + graceful fallback to the stored value on GR error).
5. **DTO + FE**: expose the amount and a `balanceStale` flag; the info page renders "Saldo deudor: $X" with an "actualizado hace…" / "dato sin confirmar" indicator.

## Risks

1. **GR `cliente` payload shape is undocumented in detail.** The skill says it includes "cuentas con deuda/facturas/URLs de pago" but not the exact JSON keys/locale of the amount. Mitigation: the adapter's `parseClientBalanceResponse` must be defensive (probe candidate keys, parse AR number format `1.234,56`), and Phase 0 captures one real payload before coding the parser. **This is the single biggest unknown.**
2. **On-demand refresh adds latency to the detail page.** A synchronous live GR call inside `GET /:id` can be slow (GR timeout is 30s). Mitigation: short dedicated timeout (e.g. 3–5s) for the on-demand path, fall back to stored value, never block past the timeout. Alternative considered: fire-and-forget async refresh (return stale now, fresh next time) — see `design.md`.
3. **Decimal handling.** `balanceDue` is money. Prisma `Decimal` must be mapped to a number/string in the DTO without float drift (the existing `toInvoice` already handles `amount.toNumber()` — reuse that pattern).
4. **Debtor set churn / staleness of who-is-a-debtor.** A client becomes/stops being a debtor between catalog syncs. The batch job re-enumerates `estado=2` each run, so it self-corrects; but a freshly-paid client may show a stale non-zero balance until the next run or an on-demand hit. Mitigation: on-demand TTL + when `cliente` reports zero debt, write `balanceDue=0`.
5. **GR rate / auth.** ~167 sequential authenticated POSTs per batch run. Mitigation: keep it sequential with the existing daily-rotating MD5 auth; no parallel hammering. If GR adds rate limits later, add a small delay/backoff (out of scope unless observed).
6. **Coupling temptation.** Folding balance into `SyncGestionRealClients` would re-introduce the 5589-call problem and couple two cadences. Keep `RefreshDebtorBalances` a SEPARATE use case + job (mirrors the repo's "mirror write side kept separate from read side" convention in `ClientMirrorRepository`).

## Rollback Plan

- Schema migration is additive (3 nullable columns) — reverting the merge leaves orphan columns harmless; a down migration `DROP COLUMN` is documented in `design.md`.
- The batch job and on-demand refresh are behind wiring; disabling the job + the on-demand branch reverts behavior to "status flag only" with zero data loss.
- No destructive DDL. No PROD data is mutated except the new balance columns.

## Affected Areas

### Backend
- `prisma/schema.prisma` — add `balanceDue`, `balanceCurrency`, `lastBalanceAt` to `Client`.
- `prisma/migrations/<ts>_client_balance_fields/migration.sql` (new — additive).
- `src/domain/entities/gestionReal.ts` — new `GrClientBalance` interface.
- `src/domain/ports/GestionRealPort.ts` — add `fetchClientBalance`.
- `src/infrastructure/adapters/gestion-real/GestionRealClient.ts` — implement `fetchClientBalance` + `parseClientBalanceResponse`.
- `src/domain/ports/ClientMirrorRepository.ts` — add `updateClientBalance` (write side).
- `src/infrastructure/adapters/prisma/PrismaClientMirrorRepository.ts` + `in-memory/InMemoryClientMirrorRepository.ts` — implement it.
- `src/application/use-cases/RefreshDebtorBalances.ts` (new — batch, debtors only).
- `src/domain/entities/customer.ts` + `src/infrastructure/adapters/prisma/PrismaCustomerRepository.ts` (`toCustomer`) — expose balance fields + `balanceStale`.
- `src/application/use-cases/GetClientDetail.ts` — on-demand stale refresh branch (needs `GestionRealPort` + mirror injected, or a small `RefreshClientBalanceIfStale` collaborator to keep DIP clean).
- `src/infrastructure/http/app.ts` — wire the new use cases (⚠ composition God Object).
- Job scheduler entry for `RefreshDebtorBalances` (wherever `SyncGestionRealClients` is triggered — confirm in Phase 0).
- Tests under `src/__tests__/` (application + infrastructure), per the in-memory port convention.

### Frontend (sibling repo — coordination only)
- Client info page: render "Saldo deudor" amount + currency + staleness indicator from the new DTO fields.
- Client type: add `balanceDue`, `balanceCurrency`, `lastBalanceAt`, `balanceStale`.

## Success Criteria

- A real debtor's info page shows the correct outstanding amount sourced from GR's `cliente` action (verified against one real GR client).
- The periodic refresh touches ONLY debtors (~167), never the full 5589.
- `GET /api/clients/:id` never 500s on GR failure — it returns the last known balance with `balanceStale: true`.
- Non-debtors report `balanceDue: 0` / `balanceStale: false` with zero GR calls.
- `npm test` green (in-memory adapters) and `tsc --noEmit` green.
