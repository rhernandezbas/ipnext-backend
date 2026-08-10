# Verify Report — `customer-balance-unmask`

Branch `fix/customer-balance-unmask`, HEAD `9fa9230b`. Read-only verify — no code touched.

## Veredicto: **PASS-with-warnings**

Gate global verde, 45/45 scenarios (spec actual, post 4 fix waves) tienen test y pasan. La única
observación con dientes es documental: la matriz del apéndice de `tasks.md` quedó desactualizada
en `assistant-balance-guard` (dice 40/40, el spec actual tiene 45 scenarios) — los 5 que faltan
SÍ tienen test verde, no es un hueco de cobertura.

## Gate global

- `npx tsc --noEmit` → **exit 0**, cero errores.
- `git status --porcelain` → limpio (working tree clean, nada sin commitear).
- Cero archivos `__probe_*` residuales (`find src -iname "*__probe*"` → vacío).
- `tasks.md`: cero `- [ ]` sin marcar en fases 0-6, 8-9. Fase 7 (runbook de deploy) tiene 3 ítems
  abiertos (7.1, 7.2, 7.3) — correcto, es la fase de deploy, no de código.
- `npx jest --listTests` incluye los 15 archivos de test relevantes (nuevos + reescritos):
  `ClienteSaldoResolver.test.ts`, `CustomerBalanceMapper.test.ts`,
  `RefreshClientBalanceIfStale.test.ts`, `GetInboxClientContext.test.ts` (messaging),
  `customerFixture.test.ts`, `PrismaCustomerRepository.mappers.test.ts`, `GetClientDetail.test.ts`,
  `GetPortalMe.test.ts`, `assistant-composition.test.ts`, `UpdateBalanceAndInvoices.test.ts`,
  `clientBalance.routes.test.ts`, `portalSelfService.routes.test.ts`, `messaging.routes.test.ts`,
  `balanceStaleness.crossSite.test.ts`, `config.balanceRefreshTimeout.test.ts` — las 15 FOUND.

## Suites de la matriz corridas explícitamente

```
13 suites (los 13 archivos "primarios" de arriba menos crossSite/config, corridos juntos):
  Test Suites: 13 passed, 13 total
  Tests:       402 passed, 402 total
  Time:        50.7s

balanceStaleness.crossSite.test.ts:  1 passed, 16 tests passed  (22.4s)
config.balanceRefreshTimeout.test.ts: 1 passed, 7 tests passed  (21.5s)
```

Total: **15 suites, 425 tests, 0 fallos.** (La suite completa del repo — 1202/1208, 12293 tests —
la corre el orquestador aparte; no se repite acá.)

## Matriz spec → scenario → test (contra el texto ACTUAL de las specs, post FW1-FW4)

Nota metodológica: enumeré los scenarios REALES leyendo los 5 `spec.md` línea por línea (no solo
el apéndice de `tasks.md`). El spec `assistant-balance-guard` tiene **18** scenarios hoy, no los
13 que aparecen en el apéndice — la matriz de `tasks.md` no se actualizó tras las fix waves 2/3
que le agregaron requirements. Total real: **45 scenarios**, no 40.

### customer-balance-truth (10/10 ✅)

| Scenario | Test | Resultado |
|---|---|---|
| active client with real debt | `PrismaCustomerRepository.mappers.test.ts` (S1) | ✅ PASSED |
| late client, unchanged parity | `PrismaCustomerRepository.mappers.test.ts` (S2) | ✅ PASSED |
| unlinked client with a stray column value | `CustomerBalanceMapper.test.ts` (S3) | ✅ PASSED |
| linked client, normal path | `CustomerBalanceMapper.test.ts` (S4) | ✅ PASSED |
| fresh active client | `CustomerBalanceMapper.test.ts` (S5) | ✅ PASSED |
| never fetched | `CustomerBalanceMapper.test.ts` (S6/S14) | ✅ PASSED |
| non-ARS currency survives | `CustomerBalanceMapper.test.ts` (S7) | ✅ PASSED |
| bot fixture goes through the real mapper | `customerFixture.test.ts` + uso en los 3 consumidores | ✅ PASSED |
| (contra) fixture bypassing mapper rejected | regla de review, sin runtime — documentada en docblock de `customerFixture.ts` | ✅ (no-runtime, ver nota) |
| portal contract and anti-IDOR scope unchanged | `GetPortalMe.test.ts` (S10) | ✅ PASSED |

### balance-staleness-helper (8/8 ✅)

| Scenario | Test | Resultado |
|---|---|---|
| no trace of the old signature | censo `rg "isBalanceStale\("` → 0 matches (confirmado en vivo) | ✅ PASSED |
| (contra) reintroduce status-keyed staleness | `ClienteSaldoResolver.test.ts` revert-probe M-B (6.3) | ✅ PASSED |
| identical verdict across all three call sites | `balanceStaleness.crossSite.test.ts` | ✅ PASSED |
| no timestamp yet | `RefreshClientBalanceIfStale.test.ts` "is stale when lastBalanceAt is null" | ✅ PASSED |
| the fast lane's effective TTL is the configured TTL | `balanceStaleness.crossSite.test.ts` "FW3 — TTL efectivo del carril rápido = TTL configurado" | ✅ PASSED |
| the knob still moves the effective TTL | `balanceStaleness.crossSite.test.ts` "la perilla sigue viva" | ✅ PASSED |
| the slow lane keeps its own margin | `balanceStaleness.crossSite.test.ts` "el carril LENTO conserva SU margen" | ✅ PASSED |
| (contra) the gate must stay open for a client who just paid | `ClienteSaldoResolver.test.ts` revert-probes FW3 (90min) + FW4 (61min, borde) | ✅ PASSED |

### assistant-balance-guard (18/18 ✅ — 5 no listados en `tasks.md`)

| Scenario | Test | Resultado |
|---|---|---|
| composition wires the collaborator | `assistant-composition.test.ts` P1 | ✅ PASSED |
| (contra) refreshBalance omitted | revert-probe M-C (6.4) | ✅ PASSED |
| active client with real debt, fresh | `ClienteSaldoResolver.test.ts` S17 | ✅ PASSED |
| yesterday's balance, refresh fails | `ClienteSaldoResolver.test.ts` S18 | ✅ PASSED |
| stale, but the refresh succeeds | `ClienteSaldoResolver.test.ts` S19 | ✅ PASSED |
| client with no GR link | `ClienteSaldoResolver.test.ts` S20 | ✅ PASSED |
| trusted balance, unconfirmed currency | `ClienteSaldoResolver.test.ts` S21 | ✅ PASSED |
| regression — confirmed currency | `ClienteSaldoResolver.test.ts` S22 | ✅ PASSED |
| **client is up to date (GR payload `debt: "0.00"`)** ⚠️ no está en el apéndice | `ClienteSaldoResolver.test.ts` "F1 — cliente al día" (línea 88) | ✅ PASSED |
| credit balance (negative debt) | `ClienteSaldoResolver.test.ts` (FW2-1) | ✅ PASSED |
| the number verifier does not whitelist the credit | `ClienteSaldoResolver.test.ts` (FW2-1, `GUIA_SALDO_A_FAVOR`) | ✅ PASSED |
| up-to-date client (exactly zero) carries no credit guidance | `ClienteSaldoResolver.test.ts` (FW2-1) | ✅ PASSED |
| the ficha still shows the credit to a human | `ClienteSaldoResolver.test.ts` (FW2-1, asimetría) | ✅ PASSED |
| (contra) resolver emits the raw negative again | revert-probe FW2-1 (8.5) | ✅ PASSED |
| **every motivo has its guidance** ⚠️ no está en el apéndice | `ClienteSaldoResolver.test.ts` "F5 — todo disponible:false lleva su guía" (`it.each`, 4 motivos, línea 395-424) | ✅ PASSED |
| **(contra) resolver returning disponible:false without guia** ⚠️ no está en el apéndice | mismo `it.each` (`toEqual` estricto incluye `guia`) — pin implícito, sin mutante corrido explícitamente | ✅ PASSED (estructural) |
| **a client who has paid off gets their mirrored invoices cleared** ⚠️ no está en el apéndice | `RefreshClientBalanceIfStale.test.ts` "DOES clear invoices when the client is fully paid off" + `ClienteSaldoResolver.test.ts` (colaborador real, línea 459-485) | ✅ PASSED |
| **a non-authoritative payload leaves the invoice mirror untouched** ⚠️ no está en el apéndice | `RefreshClientBalanceIfStale.test.ts` "does NOT wipe invoices when GR reports debt but returns an empty list" | ✅ PASSED |

### client-detail-balance (5/5 ✅)

| Scenario | Test | Resultado |
|---|---|---|
| active client with real debt | `GetClientDetail.test.ts` S23 | ✅ PASSED |
| stale client, refresh succeeds | `GetClientDetail.test.ts` S24 | ✅ PASSED |
| refresh fails or times out | `GetClientDetail.test.ts` S25 | ✅ PASSED |
| stale-but-known balance ships all three fields | `GetClientDetail.test.ts` S26 | ✅ PASSED |
| no GR link | `GetClientDetail.test.ts` S27 | ✅ PASSED |

### inbox-client-balance (4/4 ✅)

| Scenario | Test | Resultado |
|---|---|---|
| active client with real debt | `GetInboxClientContext.test.ts` S28 | ✅ PASSED |
| same TTL, same verdict everywhere | `GetInboxClientContext.test.ts` S29 | ✅ PASSED |
| no GR link | `GetInboxClientContext.test.ts` S30 | ✅ PASSED |
| agent forces a refresh | `GetInboxClientContext.test.ts` S31 (test #10 preexistente) | ✅ PASSED |

**Total: 45/45 scenarios con test verde.** (10 + 8 + 18 + 5 + 4 = 45; el apéndice de `tasks.md`
reporta 40 porque no se actualizó tras agregarle requirements a `assistant-balance-guard` en las
fix waves 2 y 3 — ver WARNING abajo.)

## Desvíos documentados (tasks.md + engram apply-progress) vs. specs actuales

Los 4 fix waves y sus desvíos quedaron reflejados correctamente en las specs:

- **FW2-2b → revertida por FW3**: el margen del carril rápido (`FAST_LANE_BATCH_MARGIN_MINUTES`)
  fue agregado en FW2 y ELIMINADO en FW3. La spec `balance-staleness-helper` actual dice
  explícitamente "no batch margin on the fast lane" y trae el contra-scenario correspondiente.
  Verificado: cero referencias a `FAST_LANE_BATCH_MARGIN_MINUTES` en `src/`. Correcto, sin deriva.
- **FW2-4 (updateClientBalance eliminado del port)**: verificado — `isBalanceStale(` da 0 matches;
  `updateClientBalance` (el no-atómico) no existe como método, sólo sobrevive
  `updateClientBalanceAndInvoices` (atómico) y comentarios que documentan la eliminación.
- **Tarea 3.10 (fixtures preexistentes NO reescritas)**: revisado contra el requirement
  "downstream fixtures must be mapper-producible" de `customer-balance-truth`. El requirement
  habla de tests que "assert behavior against a Customer value" en el sentido del bug de balance;
  los ~30 fixtures no tocados (tickets/tareas/contratos/PPPoE) no ejercitan `balanceDue`, así que
  no certifican el bug — la Fase 5.1 barrió esos archivos y confirmó que ninguno queda con un par
  `status`/`balanceDue` engañoso. No es una violación del requirement, es scoping correcto.
- **Tarea 5.2 (contra-scenario sin test automatizado)**: la spec lo declara explícitamente como
  "MUST be rejected in review" (no runtime) — coincide con lo documentado, no es un hueco.

Ningún desvío elimina algo que la spec sigue exigiendo. No encontré contradicciones spec↔código.

## Findings

### CRITICAL
Ninguno.

### WARNING
1. **Matriz del apéndice de `tasks.md` desactualizada (40/40 declarado, 45 real).** Faltan 5 filas
   de `assistant-balance-guard`: "client is up to date (GR payload debt: 0.00)" (→ test F1 en
   `ClienteSaldoResolver.test.ts` línea 88), "every motivo has its guidance" y su contra-scenario
   (→ `it.each` F5, líneas 395-424), y las 2 de mutación del invoice mirror (→
   `RefreshClientBalanceIfStale.test.ts`, casos "DOES clear invoices..." y "does NOT wipe
   invoices..."). Los 5 tienen test verde — esto es un hueco de DOCUMENTACIÓN, no de cobertura.
   El pie de página "(31 del change + 9 de la fix wave 2)" también quedó desactualizado — la nota
   FW4 en engram ya lo señala como "fuera de scope explícito de esa wave", así que arrastra desde
   FW4. Sugerido: actualizar el apéndice a 45/45 con las 5 filas faltantes antes de archivar.
2. **Contra-scenario "resolver returning disponible:false without guia" sin mutante corrido
   explícitamente.** El `it.each` de F5 usa `toEqual` estricto (incluye `guia` en el objeto
   esperado), así que ESTRUCTURALMENTE cualquier regresión que omita `guia` lo tira rojo — pero a
   diferencia de M-A/M-B/M-C/M-D/FW2-1/FW3, no hay un revert-probe documentado que lo haya
   confirmado en vivo. Riesgo bajo (la mecánica de `toEqual` es sólida), pero no está en la lista
   de mutantes medidos de la Fase 6.

### SUGGESTION
1. Considerar agregar un revert-probe explícito para "guia" ausente (borrar `guia` del branch de
   `moneda_no_confirmada` y confirmar rojo) para cerrar el WARNING 2 con evidencia medida, no sólo
   estructural — más que nada por consistencia con el resto de la Fase 6, que sí midió todo.
2. Al archivar, actualizar el pie de la matriz de `tasks.md` a "45/45 scenarios mapeados (31 del
   change + 9 de FW2 + 5 de FW2/FW3 sin listar previamente)" o similar, para que el apéndice quede
   como fuente de verdad real.

## Checklist de la casa

- (a) `- [ ]` sin marcar en fases 0-9: **solo Fase 7** (deploy, 7.1-7.3) — esperado, normal.
- (b) `__probe_*` residuales: **cero**.
- (c) `git status`: **limpio**.
- (d) Archivos de test nuevos en `npx jest --listTests`: **15/15 encontrados**.
