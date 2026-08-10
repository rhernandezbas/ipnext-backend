# Verify Report — `gr-receipt-annulment`

**Fecha**: 2026-08-10
**Worktree**: `.claude/worktrees/gr-receipt-annulment-be`, branch `fix/gr-receipt-annulment`
**HEAD**: `bb558602` (fix wave 2, RFX3 — streak explícito)
**Veredicto: PASS**

## 1. Gate

- `npx tsc --noEmit` → **limpio, 0 errores** (incluye el pin de aridad de tarea 6.3).
- `npx jest` (suite completa) → **1208 passed / 6 skipped de 1214 suites; 12408 passed / 88 skipped de
  12496 tests; 0 failed; 101.9 s**. Coincide con el gate que reportó la fix-wave-2 en engram
  (12408/88/0, 1208 suites, ~97 s) — sin regresión desde entonces.
- Suites de la matriz (22 archivos, corridos también en aislado): **100% verde**.

## 2. Matriz de spec-compliance — contra el texto ACTUAL de las specs

La matriz del apéndice de `tasks.md` quedó **corta**: fue escrita antes de que la fix-wave-1 agregara dos
requirements nuevos a `finance-growth/spec.md` ("An annulment on a closed month queues that month for a
snapshot rebuild" y "The annulled flag is a one-way latch"), que suman **8 scenarios** no reflejados en la
tabla (21 → 29 en `finance-growth`). Los 8 SÍ tienen test — se listan abajo con la fuente real, distinta de
la vieja tabla.

### `finance-growth` (29 scenarios reales, la tabla vieja tenía 21)

| # | Scenario (texto actual del spec) | Test | Resultado |
|---|---|---|---|
| 1 | Receipt con fecha_anulacion real se persiste anulado=true, nunca skip | `GestionRealClient.receipts.test.ts` + `mapGrReceipt.test.ts` + seam S1 | ✅ PASSED |
| 2 | Dict-keyed GR nodes normalizados a listas | `GestionRealClient.receipts.test.ts` (F11/F12, gate) | ✅ PASSED |
| 3 | Aplicaciones 1-a-N | `GestionRealClient.receipts.test.ts` (gate) | ✅ PASSED |
| 4 | Items/retenciones en sus tablas junto a aplicaciones | `GestionRealClient.receipts.test.ts` (gate) | ✅ PASSED |
| 5 | Fallo de una página no aborta el batch | `SyncGrReceiptsDelta.test.ts` / `SyncGrReceiptsBackfillBatch.test.ts` (gate) | ✅ PASSED |
| 6 | Delta gana el tick sobre reconcile y backfill | `FinanceReceiptIngestScheduler.test.ts` — `'scenario 6 — ...'` | ✅ PASSED |
| 7 | Reconcile gana el tick cuando delta está quieto y su cadencia venció | `FinanceReceiptIngestScheduler.test.ts` — `'scenario 7 — ...'` | ✅ PASSED |
| 8 | Backfill no se starvea indefinidamente | `FinanceReceiptIngestScheduler.test.ts` — `'scenario 8 — ...'` | ✅ PASSED |
| 9 | Backfill camina meses newest→oldest, una página por turno | `SyncGrReceiptsBackfillBatch.test.ts` (gate) | ✅ PASSED |
| 10 | Backfill resumable mid-page, se detiene en el floor | `SyncGrReceiptsBackfillBatch.test.ts` (gate) | ✅ PASSED |
| 11 | Delta avanza con overlap en cadencia real-time | `SyncGrReceiptsDelta.test.ts` (gate) | ✅ PASSED |
| 12 | Fallos repetidos degradan el pacing compartido de los 3 carriles | `finance-receipts-ingest-seam.test.ts` (S6, delta envenenado + reconcile envenenado) + `FinanceReceiptIngestScheduler.test.ts` (F4) | ✅ PASSED |
| 13 | Reconcile caza confirmado tarde | `finance-receipts-ingest-seam.test.ts` — `'S4 — ... (scenario 13)'` | ✅ PASSED |
| 14 | Re-barrer la misma ventana REESCRIBE sin duplicar | `finance-receipts-ingest-seam.test.ts` — `'re-sweeping ... (scenario 14)'` | ✅ PASSED |
| 15 | Ventana del reconcile = knob de cobertura, no invariante de corrección | `syncConfigNormalizer.test.ts` (U5, `20` aceptado tal cual) + `SyncGrReceiptsReconcileWindow.test.ts` (U6) | ✅ PASSED |
| 16 | Anulación en mes cerrado encola ese mes | `financeReceiptPageIngest.test.ts` — describe `RF3` | ✅ PASSED |
| 17 | Flip cerca del borde de mes se encola pese al horizonte nocturno | `financeReceiptPageIngest.test.ts` — describe `RFX1` (P1, traza con dos relojes) | ✅ PASSED |
| 18 | Flip del mes CORRIENTE no encola nada | `financeReceiptPageIngest.test.ts` — RF3 + RFX1 `BORDER` | ✅ PASSED |
| 19 | Rebuild fallido mantiene el mes encolado | `FinanceSnapshotScheduler.test.ts` (desencola solo lo reconstruido con éxito) | ✅ PASSED |
| 20 | Un recibo espejado flipea a anulado | `finance-receipts-ingest-seam.test.ts` (S2) + `financeReceiptPageIngest.test.ts` (RF1: log del flip) | ✅ PASSED |
| 21 | GR blanking fecha_anulacion nunca des-anula el espejo | `PrismaFinancePaymentReceiptRepository.test.ts` (`update` omite `anulado` en `false`) + `InMemoryFinancePaymentReceiptRepository.test.ts` (`true → false` no flipea) + seam `S2-latch` | ✅ PASSED |
| 22 | Tres guard-aborts consecutivos abandonan el barrido | `SyncGrReceiptsReconcileWindow.test.ts` — describe `RF4` (+ hermano en `SyncGrReceiptsDelta.test.ts`) | ✅ PASSED |
| 23 | El contador de aborts sobrevive un error intercalado | `SyncGrReceiptsReconcileWindow.test.ts` — `'RFX3: an ECONNRESET between two aborts...'` (+ hermano delta) | ✅ PASSED |
| 24 | Sobre de error de GR durante reconcile nunca degrada a escritura vacía | `SyncGrReceiptsReconcileWindow.test.ts` (4.9) + seam (scenario 16) | ✅ PASSED |
| 25 | ISO reconocido como anulación real, sin warning | `financeDates.test.ts` — describe `ISO accepted...` | ✅ PASSED |
| 26 | Centinela todo-ceros en cualquier ancho/orden sigue "no anulado" | `financeDates.test.ts` (F10 + ISO-shaped sentinel) | ✅ PASSED |
| 27 | Residuo no parseable marca solo esa fila | `financeDates.test.ts` (residuo) + `financeAnnulmentGuard.test.ts` + seam S5 | ✅ PASSED |
| 28 | Corrida normal con 0/pocos anulados persiste normal | `financeAnnulmentGuard.test.ts` | ✅ PASSED |
| 29 | Drift del centinela satura la página y aborta sin escribir | `financeAnnulmentGuard.test.ts` + seam S5 (63/100 residuo) | ✅ PASSED |

### `finance-dashboard-annulment-filter` (5 scenarios, matriz OK)

| # | Scenario | Test | Resultado |
|---|---|---|---|
| 22 | Items de recibo anulado excluidos de la caja mensual | `PrismaFinanceReceiptItemRepository.test.ts` | ✅ PASSED |
| 23 | Items de recibo anulado excluidos del total mensual de un cliente | `PrismaFinanceReceiptItemRepository.test.ts` | ✅ PASSED |
| 24 | Aplicaciones excluidas de unclassifiedAmountArs | `PrismaFinanceReceiptApplicationRepository.test.ts` + `BuildFinanceMonthlySnapshot.test.ts` | ✅ PASSED |
| 25 | Aplicaciones excluidas de la atribución CAC/payback | `PrismaFinanceReceiptApplicationRepository.test.ts` + `ComputeCacAndPayback.test.ts` | ✅ PASSED |
| 26 | Revert-probe: sacar el filtro de cualquiera de los 4 pone su test en rojo | `InMemoryFinanceReceiptItemRepository.test.ts` + `InMemoryFinanceReceiptApplicationRepository.test.ts` (gemelos) | ✅ PASSED |

### `portal-payments` (3 scenarios, matriz OK)

| # | Scenario | Test | Resultado |
|---|---|---|---|
| 27 | Recibo anulado por el reconcile desaparece de Mis pagos | `PrismaPortalPaymentsReader.test.ts` | ✅ PASSED |
| 28 | Revert-probe: retirar el filtro pone el test en rojo | `PrismaPortalPaymentsReader.test.ts` (fixture con anulado real, monto ≠ 0) | ✅ PASSED |
| 29 | Recibo nunca anulado sigue apareciendo sin cambios | `PrismaPortalPaymentsReader.test.ts` (PAY-1.5 preexistente, gate) | ✅ PASSED |

**Total: 37/37 scenarios reales de las 3 specs, todos con test, todos PASSED.** (0 CRITICAL — la matriz
del apéndice de `tasks.md` debe actualizarse a 37 filas antes de archivar; es un defecto de documentación,
no de implementación, porque los 8 scenarios faltantes SÍ tienen test verde.)

## 3. Desvíos documentados — chequeo contra el texto actual de las specs

Todos los desvíos que engram (`sdd/gr-receipt-annulment/apply-progress`, obs #2363) y `tasks.md` declaran
como "CERRADO por la fix-wave" están reflejados en el spec ACTUAL, sin contradicción:

- **Umbral `>` estricto + piso `annulmentGuardMinCount`**: spec dice `>` y `>=` piso; `financeAnnulmentGuard.ts:54`
  implementa `annulled >= cfg.annulmentGuardMinCount && annulled * 100 > cfg.annulmentGuardMaxPct * total`
  (aritmética entera). Coincide exacto.
- **ISO ⇒ `true`**: el spec actual (post RF14) dice `THEN devuelve true`; la implementación en
  `financeDates.ts`/`isRealAnnulment` devuelve `true` para ISO. Coincide.
  - **Hallazgo menor (no bloqueante)**: el comentario en `financeDates.test.ts:73-83` sigue describiendo
    el conflicto spec/design como si no estuviera resuelto ("sdd-verify NOTE... flagged for sdd-verify to
    fix the spec text") — pero el spec YA fue corregido por RF14. Es un comentario de código stale, no
    afecta comportamiento ni el resultado del test. **Recomendación**: limpiar ese bloque de comentario en
    un próximo touch del archivo (no amerita un commit dedicado).
- **Scenario 15 (ventana del reconcile) — el "hueco reportado" de `tasks.md`**: el spec fue enmendado y
  la ambigüedad quedó CERRADA — el texto actual dice explícitamente que `20` (dentro de `[1,90]`) "se
  acepta tal cual" y que la corrección de visibilidad la da el encolado, no el ancho de ventana. La
  implementación (`normalizeFinanceReceiptSyncConfig`, sin piso `35`) coincide con el texto enmendado.
  El hueco que `tasks.md:416-425` marca como "sdd-verify debe confirmar" está **confirmado y cerrado**.
- **Migración (5 columnas)**: `20261109000000_finance_receipt_reconcile_lane/migration.sql` — los 5
  defaults SQL (`reconcileEnabled=true`, `reconcileWindowDays=35`, `reconcileCheckIntervalMs=21600000`,
  `annulmentGuardMaxPct=5`, `annulmentGuardMinCount=5`) coinciden byte a byte con
  `FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS` en `FinanceReceiptSyncConfigRepository.ts:58-62`. Sin drift.
- **Runbook fase 10 — paths `/growth`**: confirmado en código — `app.ts:3769` monta
  `createFinanceGrowthRouter` en `/api/finance/growth`, y las rutas son `/sync/rearm-backfill` y
  `/sync/backfill-snapshots` (`financeGrowth.routes.ts:364,381`) → las URLs completas del runbook
  (`/api/finance/growth/sync/...`) son correctas.
- **Query de los 102 (`count FILTER (WHERE anulado = false)`) + comillas simples**: `grReceiptId` es
  `String @id` en `schema.prisma:2685` — confirma que la nota de comillas simples (10.5) es necesaria y
  correcta; sintaxis del `FILTER` es Postgres válida.
- **Latch de un solo sentido + auditoría (fase 10.11)**: el log `ANULACION recibo=... anulado:false->true
  fecha_anulacion_cruda="..."` existe literal en `financeReceiptPageIngest.ts` y está pineado en
  `financeReceiptPageIngest.test.ts` (describe `RF1: the per-flip audit log`) — el runbook de auditoría
  es ejecutable tal como está escrito.
- **RFX1 (encolado por "≠ mes corriente", no por horizonte)**: implementación en `financeReceiptPageIngest.ts`
  vía `financeSnapshotRebuildQueue.ts`; `isWithinNightlyRebuildHorizon` fue eliminado (confirmado — no hay
  matches del símbolo en `src/`, solo `nightlyRebuildHorizon` como tupla consumida por
  `FinanceSnapshotScheduler.ts`). Coincide con el spec actual del requirement "An annulment on a closed
  month queues that month for a snapshot rebuild".
- **RFX3 (streak persistido, no parseado)**: `financeGuardAbortStreak.ts` existe, usado en
  `SyncGrReceiptsReconcileWindow.ts` y `SyncGrReceiptsDelta.ts`; no quedan matches de `guardAborts=N` /
  `parseGuardAbortStreak` en `src/`. Coincide con el spec actual ("MUST NOT derivarse del último
  `lastResult`").

**Ningún desvío deja a la spec pidiendo algo que el código no hace.** Cero CRITICAL.

## 4. Checklist

- Tareas 1-9 (`tasks.md`): **todas `[x]`** — confirmado línea por línea.
- Fase 10 (runbook post-push): **todas `[ ]`**, correcto — es post-deploy, no bloquea el archive de código.
- `find src -iname "*__probe_*"` → **vacío**, cero archivos de probe residuales.
- `git status --porcelain` → **vacío**, working tree limpio, HEAD = `bb558602`.
- `npx jest --listTests` → confirma presencia de los 7 archivos de test nuevos de la fix-wave
  (`financeReceiptPageIngest.test.ts`, `financeAnnulmentGuard.test.ts`, `SyncGrReceiptsReconcileWindow.test.ts`,
  `syncConfigNormalizer.test.ts`, `finance-growth-composition-root.test.ts`,
  `InMemoryFinancePaymentReceiptRepository.test.ts`, `PrismaFinancePaymentReceiptRepository.test.ts`) — total
  1214 suites (sin inflación por worktrees residuales, coherente con el conteo previo de engram).

## Veredicto

**PASS.** 37/37 scenarios reales verificados contra el texto ACTUAL de las 3 specs, todos con test
identificado y verde. Gate limpio (`tsc` + suite completa 12408/12408 sin skips fallidos). Cero desvío
documentado deja a una spec pidiendo algo no implementado. Un solo hallazgo no bloqueante: la matriz del
apéndice de `tasks.md` debe ampliarse de 21 a 29 filas en `finance-growth` antes de `sdd-archive` (los 8
scenarios de los dos requirements agregados por la fix-wave-1 ya tienen test, solo falta que la tabla los
liste), y el comentario stale en `financeDates.test.ts:73-83` puede limpiarse de yapa.
