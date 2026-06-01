# Design — gr-client-balance-sync

## Technical Approach

The product needs the client's outstanding debt **amount** on the info page. Two facts shape the entire design:

1. **The amount is per-client.** It comes from GR's `cliente` action (`{"action":"cliente","cliente_id":N}`), which returns one client's full picture including "cuentas con deuda/facturas/URLs de pago". There is **no bulk endpoint** returning balances for many clients — `clientes_consulta` (the action that feeds the current mirror, `GestionRealClient.fetchClients`) does NOT include the amount.
2. **The interesting set is small.** Of ~5589 clients, only debtors (estado `2`) have a non-zero balance worth showing. The current snapshot has ~167 debtors. A non-debtor owes 0 by definition — no GR call needed.

So the cost model is: "1 GR request per debtor". Everything below optimizes around minimizing how often we pay that cost while keeping the displayed number trustworthy.

The existing mirror cleanly separates write (`ClientMirrorRepository`) from read (`CustomerRepository`), and the GR transport/normalization lives behind `GestionRealPort` (`GestionRealClient` owns auth + parsing, the app layer sees only normalized shapes). We extend along those exact seams — no new architectural pattern.

## Architecture Decisions

### AD-1 — Store balance in dedicated `Client` columns, NOT `customAttributes`

**Choice**: Add `balanceDue Decimal?`, `balanceCurrency String?`, `lastBalanceAt DateTime?` to `Client`.

**Alternatives**:
- **`customAttributes Json?`** (already exists, currently holds the raw `clientes_consulta` payload). Rejected: (a) money in JSON has no type/precision guarantee and can't be queried/indexed/aggregated; (b) `customAttributes` is overwritten wholesale by `upsertClient` on every catalog sync (`PrismaClientMirrorRepository.ts:47` sets `customAttributes: c.raw`), so a balance written there would be **clobbered** by the next `SyncGestionRealClients` run — a silent data-loss bug; (c) we need `lastBalanceAt` as a real `DateTime` for TTL comparisons.
- **A separate `ClientBalance` table** (1:1). Rejected as over-engineered for three scalar fields with no history requirement (history is explicitly Scope OUT). If we later want a balance audit trail, that's a clean follow-up.

**Rationale**: `Decimal` gives money precision; dedicated columns survive the catalog sync's `customAttributes` overwrite; `lastBalanceAt DateTime` drives the staleness logic. All nullable → additive, non-breaking for the 5589 existing rows and fixtures (mirrors the `grClienteId String?` and `projectId?` "optional to not break fixtures" convention noted in CLAUDE.md).

### AD-2 — SYNC STRATEGY: Hybrid (debtor-scoped batch + on-demand TTL refresh) — THE KEY DECISION

Three options were on the table:

| Option | What it does | Cost | Freshness | Verdict |
|--------|--------------|------|-----------|---------|
| **(a) On-demand only** | Live `cliente` call every time the info page opens (with short cache) | ~0 background; 1 call per page view (deduped by cache TTL) | Always fresh on view | Adds latency to EVERY debtor page view; if GR is slow/down the page degrades; repeated views of the same client re-hit GR unless cached |
| **(b) Batch only, debtors** | Periodic job: enumerate `estado=2` via `clientes_consulta`, call `cliente` per debtor (~167), store amount | ~167 calls/run, bounded | Fresh to within one job interval; a just-paid client shows stale until next run | Cheap, predictable; but the page can show a balance that's hours old right after a payment |
| **(c) Hybrid** | (b) as the baseline + on-demand refresh ONLY when the viewed debtor's `lastBalanceAt` exceeds a TTL | ~167/run + at most 1 call per stale page view | Background freshness + on-view correction | Best of both; slightly more code |

**Choice**: **(c) Hybrid.**

**Rationale**:
- **Why not (a) alone**: with no stored baseline, the list/cards can never show a balance without N live calls, and a GR outage means NO balance anywhere. It also wastes calls re-fetching unchanged balances on every view.
- **Why not (b) alone**: the single most embarrassing failure is "client just paid, page still says they owe money". A pure interval can't fix that until the next run.
- **Why (c)**: the batch job keeps a cheap, always-available baseline for ~167 debtors (so lists and first paint are instant and offline-resilient), and the on-demand TTL refresh corrects the one case the user is actually looking at, on the rare occasion it's stale. The cost ceiling stays ~167 + occasional singletons — never the 5589-call cliff that folding balance into `SyncGestionRealClients` would create.

**Parameters** (config, with defaults):
- Batch interval: hourly (or daily off-peak — operationally tunable; the job is idempotent).
- On-demand TTL: `BALANCE_STALE_TTL_MINUTES` default 60. If `now - lastBalanceAt > TTL` → attempt one live refresh.
- On-demand timeout: `BALANCE_REFRESH_TIMEOUT_MS` default 4000 (well under GR's 30s default) → on timeout/error, serve the stored value with `balanceStale: true`.

### AD-3 — On-demand refresh: synchronous-with-fallback, not fire-and-forget

**Choice**: When a stale debtor detail is requested, attempt a live `fetchClientBalance` with a short timeout INSIDE the request; on success update the row and return fresh; on timeout/error return the stored value flagged stale.

**Alternative**: fire-and-forget — return stale immediately, refresh in the background so the *next* view is fresh. Rejected as the default because the user opened the page precisely to see the current debt; making them refresh to get the right number is poor UX. (Fire-and-forget remains a valid fallback if synchronous latency proves problematic — it's a one-line switch.)

**DIP note**: `GetClientDetail` currently depends only on `CustomerRepository`. To keep it from ballooning, introduce a small collaborator `RefreshClientBalanceIfStale` (depends on `GestionRealPort` + `ClientMirrorRepository`) that `GetClientDetail` optionally invokes — or inject the two ports directly. Either way the use case must NOT import the adapter or Prisma (strict DIP per CLAUDE.md `b708dc89`).

### AD-4 — Defensive balance parser (`parseClientBalanceResponse`)

**Choice**: A pure exported function (same style as `parseClientsResponse`/`parseContractsResponse`) that takes the raw `cliente` payload and returns `GrClientBalance`. It must:
- Probe candidate keys for the debt total (the exact GR key is unknown until Phase 0 captures a real payload).
- Parse Argentine number format (`"1.234,56"` → `1234.56`) defensively, tolerating already-numeric values.
- Default to `{ amount: 0 }` when the payload indicates no debt.
- Optionally extract payment URLs (Siro/MercadoPago/PagoFácil/Macro) for storage, even though wiring a pay button is Scope OUT.

**Rationale**: The skill documents the `cliente` action's *contents* but not exact JSON keys/locale. Isolating parsing in a pure, unit-tested function lets us pin the shape from one real sample and harden it without touching transport.

### AD-5 — Keep balance write side OFF the catalog sync

**Choice**: `RefreshDebtorBalances` is a NEW use case with its own job trigger; `updateClientBalance` is a NEW `ClientMirrorRepository` method that touches ONLY the three balance columns (never `customAttributes`, never status).

**Rationale**: `SyncGestionRealClients` overwrites `customAttributes` and maps status from `clientes_consulta`; it must not call `cliente` (5589-call problem) and balance updates must not be clobbered by it. Separate cadence, separate write path — consistent with the existing read/write separation in `ClientMirrorRepository`.

## Data Model Change

```prisma
model Client {
  // ... existing fields ...
  balanceDue      Decimal?   // outstanding debt amount from GR `cliente`; null = never fetched, 0 = no debt
  balanceCurrency String?    // e.g. "ARS"; null until first fetch
  lastBalanceAt   DateTime?  // when balanceDue was last refreshed from GR
  // ...
}
```

All nullable, additive. No index needed (lookups are by `id`/`grClienteId`, already indexed/unique).

## Normalized Shape

```ts
// src/domain/entities/gestionReal.ts
export interface GrClientBalance {
  grClienteId: string;
  /** Outstanding debt amount; 0 when the client owes nothing. */
  amount: number;
  /** Currency code, e.g. "ARS". Null when GR omits it. */
  currency: string | null;
  /** Optional payment URLs by provider (siro/mercadopago/pagofacil/macro). */
  paymentUrls?: Record<string, string>;
  /** Full GR `cliente` payload, for debugging/fidelity (NOT persisted to customAttributes). */
  raw: Record<string, unknown>;
}
```

## Port Additions

```ts
// GestionRealPort
fetchClientBalance(grClienteId: string): Promise<GrClientBalance>;

// ClientMirrorRepository (write side)
updateClientBalance(grClienteId: string, amount: number, currency: string | null, at: Date): Promise<void>;
```

## DTO Exposure (`toCustomer` + `Customer` entity)

Add to `Customer`:
```ts
balanceDue?: number | null;      // mapped from Decimal via .toNumber() (reuse toInvoice pattern)
balanceCurrency?: string | null;
lastBalanceAt?: string | null;   // ISO
balanceStale: boolean;           // derived: status==='late' && (lastBalanceAt null || older than TTL)
```
`balanceStale` is computed in the read path (use case/mapper), not stored.

## Migration Plan (additive, forward-only)

### `<ts>_client_balance_fields/migration.sql`
```sql
ALTER TABLE "Client" ADD COLUMN "balanceDue"      DECIMAL(12,2);
ALTER TABLE "Client" ADD COLUMN "balanceCurrency" TEXT;
ALTER TABLE "Client" ADD COLUMN "lastBalanceAt"   TIMESTAMP(3);
```
### Down (manual, schema only)
```sql
ALTER TABLE "Client" DROP COLUMN IF EXISTS "balanceDue";
ALTER TABLE "Client" DROP COLUMN IF EXISTS "balanceCurrency";
ALTER TABLE "Client" DROP COLUMN IF EXISTS "lastBalanceAt";
```
> Generate via `npm run prisma:migrate` — never hand-edit SQL except to confirm it matches `schema.prisma` (`prisma migrate diff` clean).

## Error / Staleness Handling

| Situation | Behavior |
|-----------|----------|
| Batch job, GR fails for one debtor | Log + skip that debtor; continue the loop; leave its `lastBalanceAt` unchanged (it ages → flagged stale on next view). Run does not abort. |
| Batch job, GR fails wholesale | Same try/catch + sync-state pattern as `SyncGestionRealClients` (record `error: <msg>`); next run retries. |
| On-demand refresh times out / errors | Serve stored `balanceDue` with `balanceStale: true`; detail endpoint still 200. Never 500 on GR. |
| `cliente` reports no debt | Write `balanceDue = 0`, fresh `lastBalanceAt`. |
| Client is not a debtor (status ≠ late) | `balanceDue = 0`, `balanceStale = false`, zero GR calls. |
| `lastBalanceAt` null for a debtor | Treated as stale → on-demand refresh attempted on view; until then show "—" / "sin confirmar". |

**Staleness definition**: a debtor's balance is STALE when `lastBalanceAt` is null OR `now - lastBalanceAt > BALANCE_STALE_TTL_MINUTES`.

## Frontend Coordination Contract

The client info page renders, for debtors:
- **"Saldo deudor: $X.XXX,XX"** from `balanceDue` + `balanceCurrency`.
- A freshness indicator from `lastBalanceAt` + `balanceStale`: "actualizado hace N min" when fresh, "dato sin confirmar / actualizando…" when `balanceStale`.
- For non-debtors: either hide the row or show "Sin deuda".

New client-type fields: `balanceDue`, `balanceCurrency`, `lastBalanceAt`, `balanceStale`. Mechanical; lands with the backend DTO change.

## Testing Strategy (STRICT TDD — in-memory ports, never mock Prisma)

| Focus | Type |
|-------|------|
| `parseClientBalanceResponse`: real-sample payload → correct amount; AR number format `"1.234,56"`; no-debt → 0; missing keys → 0 defensively | Unit (pure fn) |
| `RefreshDebtorBalances`: enumerates only `estado=2`; calls `fetchClientBalance` per debtor; upserts via `InMemoryClientMirrorRepository`; one GR failure skips that debtor without aborting | Use-case unit (in-memory) |
| `updateClientBalance` (InMemory + Prisma mapper test): writes only the 3 balance columns, leaves `customAttributes`/status untouched | Adapter unit |
| On-demand: stale debtor → live refresh updates row; GR timeout → stored value + `balanceStale:true`, endpoint 200 | Use-case unit + supertest |
| `toCustomer`: `Decimal` → number (no float drift); `balanceStale` derivation; non-debtor → 0/false | Mapper unit |
| `GET /api/clients/:id` for a debtor: returns balance fields; GR down → still 200 with stale flag | supertest (in-memory injected) |

## Open Questions

1. **Exact `cliente` payload keys + currency locale** — RESOLVE IN PHASE 0 by capturing one real GR response. The parser is written against that sample. (Biggest unknown.)
2. **Where is `SyncGestionRealClients` currently triggered** (cron? manual route? container boot?) — the same mechanism hosts the `RefreshDebtorBalances` job. Confirm in Phase 0.
3. **Synchronous vs fire-and-forget on-demand** — default synchronous-with-fallback (AD-3); flip to fire-and-forget if measured detail-page latency is unacceptable.
4. **Batch interval** — hourly vs daily; tune after observing debtor-set churn and GR responsiveness. Job is idempotent either way.
