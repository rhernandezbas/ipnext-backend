# Archive Report: customer-balance-unmask

**Change**: customer-balance-unmask
**Date Archived**: 2026-08-10
**Artifact Store**: openspec (filesystem)
**Archive Path**: openspec/changes/archive/2026-08-10-customer-balance-unmask/
**Deploy SHA**: `cb11b9ed`
**Branch**: `fix/customer-balance-unmask`, apply HEAD `9fa9230b`

## SDD Cycle Complete

Proposal → spec → design → tasks → apply (4 fix waves) → verify (PASS-with-warnings, 0 CRITICAL) → archive.

## Capabilities Added (5 new)

| Capability | Main Spec Path |
|------------|----------------|
| customer-balance-truth | openspec/specs/customer-balance-truth/spec.md |
| balance-staleness-helper | openspec/specs/balance-staleness-helper/spec.md |
| assistant-balance-guard | openspec/specs/assistant-balance-guard/spec.md |
| client-detail-balance | openspec/specs/client-detail-balance/spec.md |
| inbox-client-balance | openspec/specs/inbox-client-balance/spec.md |

All 5 were copied verbatim from the change's delta specs — none existed as canonical specs before this
change (confirmed: `openspec/specs/` had no matching directories pre-archive).

## Problem and Fix

`toCustomer` (`PrismaCustomerRepository.ts`) forced `balanceDue`/`balanceCurrency` to `0`/`null` for every
`CustomerStatus` other than `late`, even though the 2026-08-04 fast-lane (`gr-balance-refresh-lanes`)
already writes a real `balanceDue` into the row for GR estados 1/2/3/4 every hour. The masking discarded
data the same request had just written. Measured impact (prod, 2026-08-10): 73 `late` clients saw the real
number; 5.323 `active` clients always saw 0; **3.213 non-`late` clients with real `balanceDue > 0` were told
they owed nothing** across three surfaces — client ficha (`GET /api/clients/:id`), human inbox
(`GetInboxClientContext`), and the WhatsApp bot (`ClienteSaldoResolver`).

Fix: `toCustomer` stops masking by status — the column maps for every status, `null` stays `null` ("unknown",
never a lie). Staleness becomes status-agnostic (`isBalanceOlderThanTtl(lastBalanceAt, ttl)` — the same
helper already live in the inbox refresh path), replacing the old `isBalanceStale(status, ...)` that
short-circuited open for every non-`late` client regardless of how old the stamp was. `refreshBalance` was
wired into `composeAssistantEngine` — it was previously dead code (constructed with the collaborator but
never passed by `app.ts`), which would have left the bot silent most of the time under the new stricter gate.

## Live Verification (post-deploy, prod)

- Cliente **109143**: `balanceDue` real de **20.611** confirmado vía `GET /api/clients/109143` — antes del
  deploy la ficha reportaba 0 (masking activo) pese a que el fast-lane ya había escrito el número real en la
  fila.
- Gate: `tsc --noEmit` limpio, suite completa verde (15 archivos de test nuevos/reescritos, 425 tests en las
  suites de la matriz, 0 fallos).

## Review Rounds (4 fix waves)

1. **FW1 / M-A, M-B, M-C, M-D** — cerraron los 4 mutantes iniciales del masking removal (fixtures que
   certificaban un `Customer` que `toCustomer` nunca produce, `refreshBalance` no cableado, staleness
   status-aware sobreviviendo en un rincón, contra-scenario de fixture bypass sin runtime documentado).
2. **FW2** — agregó `FAST_LANE_BATCH_MARGIN_MINUTES` al carril rápido (luego revertido en FW3), sumó el
   manejo de saldo a favor (crédito, debt negativo) al bot sin whitelistearlo en el verificador de números,
   y agregó guía por cada `motivo` de `disponible:false`.
3. **FW3** — revirtió el margen de batch del carril rápido: la spec `balance-staleness-helper` quedó
   explícita en "no batch margin on the fast lane" con su contra-scenario.
4. **FW4** — cerró la limpieza de invoices espejadas cuando el cliente salda completo (y el caso simétrico:
   un payload no autoritativo de GR no debe barrer el espejo de facturas).

## Verify Report Findings

**Veredicto: PASS-with-warnings.** 45/45 scenarios reales (post 4 fix waves) tienen test y pasan — el
apéndice de `tasks.md` reportaba 40/40 porque no se actualizó tras las fix waves 2/3 que agregaron
requirements a `assistant-balance-guard`. Cero CRITICAL. Dos WARNING, ambos documentales (matriz desactualizada,
un contra-scenario cubierto solo estructuralmente por `toEqual` sin revert-probe explícito) — ninguno deja a
la spec pidiendo algo que el código no hace.

## Deliberate Out-of-Scope (documented in proposal, not revisited here)

- Opción B (derivar saldo de facturas espejadas) — rechazada con evidencia: 77% de la base no tiene facturas
  espejadas.
- Moneda hardcodeada `'ARS'` en el parser GR — deuda preexistente, 43 facturas `DOL` en prod, change aparte.
- Frontend (`BalanceCard` 3 estados + indicador de frescura en el inbox) — change coordinado, BE primero por
  diseño (precedente `portal-payments`).
