# Tasks: pppoe-add-dedup (Cambio A)

> Estricto TDD (red→green→refactor). El gate (suite completa + `tsc --noEmit`) lo corre el orquestador, NO se confía en el reporte del agente. Worktree dedicado `ipnext-backend/.claude/worktrees/pppoe-add-dedup-be`. El FE es un cambio coordinado en `ipnext-frontend` (worktree + PR aparte).

## Phase 0 — Baseline
> Checkpoint: `npx tsc --noEmit` y `npm test` verdes ANTES de tocar nada (red de seguridad del refactor).

- [ ] 0.1 Correr `npm test` + `npx tsc --noEmit` en `main` → registrar el baseline (N tests verdes) — (verificación) — 10m
- [ ] 0.2 Confirmar `DeviceTypeCatalog` tiene `ROUTER` + `ANTENA` (o que `OTROS` cubre) — `rg`/seed — 5m — Open question #2 del design

---

## Phase 1 — Commit 1: Extraer `InstallContractAsset` (refactor SIN cambio de comportamiento)
> Gate: tests existentes de inventario VERDES sin modificarlos (`ConfirmInventoryAtomicity`, `inventory.routes`, `inventory-composition-root`). Commit: `refactor(inventory): extract InstallContractAsset from dualWriteAsset`

- [ ] 1.1 Crear `src/application/services/InstallContractAsset.ts`: `installNew(b, args)` con la lógica EXACTA de `ConfirmInventorySuggestion.dualWriteAsset:135-214` (synth serial MAC-only, findByNormalizedSerialAny/findByMac, reuse scoped, `AssetInstalledElsewhereError`, `INSTALL` movement) — (Create) — 30m — dep 0.1
- [ ] 1.2 Refactor `ConfirmInventorySuggestion.ts`: `dualWriteAsset` delega en `install.installNew(b, …)`; inyectar `InstallContractAsset` (o construirlo de las deps existentes) sin cambiar la firma pública del use case — (Modify) — 20m — dep 1.1
- [ ] 1.3 Gate: `npm test` (suite inventario) verde **sin tocar** los tests + `tsc --noEmit` — (verificación) — 10m — dep 1.2
- [ ] 1.4 Commit — (git) — 2m — dep 1.3

---

## Phase 2 — Commit 2: `matchEquipment` (núcleo puro) + delegar `matchInstalledItem`
> Gate: tests de `matchInstalledItem` verdes sin tocar + tests nuevos de `matchEquipment`. Commit: `feat(inventory): matchEquipment core with removed-aware precedence`

- [ ] 2.1 **RED**: `src/__tests__/application/matchEquipment.test.ts` — casos: same_device por MAC, por SN, normalización (`SN-001`==`sn001`, `aa:bb`==`AABB`), precedencia activo>removed, same_type, null; candidate `{type,serialNumber,mac}` — (Create) — 25m — dep Phase 1
- [ ] 2.2 **GREEN**: `src/application/services/matchEquipment.ts` — función pura `matchEquipment(candidate, items)` reusando `normalizeSerial/normMac/normSn`; precedencia same_device(active)→same_device(removed)→same_type(active)→same_type(removed)→null — (Create) — 20m — dep 2.1
- [ ] 2.3 Refactor `matchInstalledItem.ts`: delegar en `matchEquipment` (adaptar suggestion→candidate, seguir pasando solo activos) — comportamiento idéntico — (Modify) — 15m — dep 2.2
- [ ] 2.4 Gate: tests `matchInstalledItem` + `matchEquipment` verdes + `tsc` — (verificación) — 5m — dep 2.3
- [ ] 2.5 Commit — (git) — 2m — dep 2.4

---

## Phase 3 — Commit 3: Use case `AddContractEquipment` (TDD)
> Gate: tests del use case verdes (in-memory) + suite existente verde. Commit: `feat(inventory): AddContractEquipment with dedup, enrich/revive and dual-write`

- [ ] 3.1 Agregar `SameTypeNeedsDecisionError` (con `candidates`) a `src/domain/errors/inventory.ts` — (Modify) — 10m — dep Phase 2
- [ ] 3.2 `InstallContractAsset.reconcileForEnrich(b, …)`: revive del activo de un item enriquecido (`removed→available→installed` vía `nextStatus`, completar `asset.mac`, movimiento) o crear activo si el item no tenía — (Modify) — 25m — dep 3.1. Requiere test previo.
- [ ] 3.3 **RED**: `src/__tests__/application/AddContractEquipment.test.ts` — escenarios del spec: same_device-active→enrich(200), same_device-removed→revive, match por SN, enrich-no-pisa, alta-nueva→CII+asset+INSTALL(201), MAC-only→serial sintetizado, atomicidad-rollback, AssetInstalledElsewhere, same_type→`SameTypeNeedsDecisionError`, completeItemId→enrich, force→create, same_device-gana-sobre-force — (Create) — 50m — dep 3.2. Requiere test previo.
- [ ] 3.4 **GREEN**: `src/application/use-cases/AddContractEquipment.ts` — flujo de precedencia (Decisión 1/3 del design), `runUnit` para enrich y create, deps opcionales W1 — (Create) — 50m — dep 3.3
- [ ] 3.5 Verificar I-1 (DIP): `rg "from '@infrastructure" src/application/use-cases/AddContractEquipment.ts src/application/services/InstallContractAsset.ts src/application/services/matchEquipment.ts` → 0 — (verificación) — 2m — dep 3.4
- [ ] 3.6 Gate: `npm test` + `tsc --noEmit` verdes — (verificación) — 10m — dep 3.5
- [ ] 3.7 Commit — (git) — 2m — dep 3.6

---

## Phase 4 — Commit 4: HTTP wiring + reemplazo de `AddInstalledItemManually`
> Gate: tests de ruta (200/201/409) + composition-root + suite completa verde. Commit: `feat(http): wire AddContractEquipment on POST inventory (dedup-aware)`

- [ ] 4.1 Zod del POST `/contracts/:id/inventory`: sumar `completeItemId?: string`, `force?: boolean` (opcionales) — `contractInventory.routes.ts` (Modify) — 10m — dep Phase 3. Requiere test previo.
- [ ] 4.2 **RED**: extender `src/__tests__/infrastructure/inventory.routes.test.ts` (o `serviceInventory.routes.test.ts`): POST → 201 nuevo, 200 enrich (same_device), 409 `SAME_TYPE_NEEDS_DECISION` con candidates, 200 con completeItemId, 201 con force — (Modify) — 30m — dep 4.1. Requiere test previo.
- [ ] 4.3 **GREEN**: la ruta POST llama `AddContractEquipment`; mapear `created`→201/`!created`→200; `SameTypeNeedsDecisionError`→409 con `{error, candidates}` (handler de error) — (Modify) — 25m — dep 4.2
- [ ] 4.4 Wire en `src/infrastructure/http/app.ts`: instanciar `AddContractEquipment` con `inventory/catalog/locations/assets/movements/uow/install`; reemplazar el uso de `AddInstalledItemManually` — (Modify) — 20m — dep 4.3
- [ ] 4.5 Eliminar `src/application/use-cases/AddInstalledItemManually.ts` + su test (comportamiento absorbido) — `rg "AddInstalledItemManually" src/` → 0 — (Delete) — 10m — dep 4.4
- [ ] 4.6 **Composition-root test** (`src/__tests__/infrastructure/inventory-composition-root.test.ts`, extender): assert estático de que el POST inventory corre con dual-write (assets/movements/uow inyectados al `AddContractEquipment`) — (Modify) — 20m — dep 4.4
- [ ] 4.7 Gate: `npm test` suite completa + `tsc --noEmit` — (verificación) — 10m — dep 4.6
- [ ] 4.8 Commit — (git) — 2m — dep 4.7

---

## Phase 5 — Commit 5: Migración de limpieza de duplicados
> Gate: SQL revisado con el usuario + dry-run rolled-back vs prod. Commit: `feat(prisma): migration to dedup pre-existing contract equipment by (contract, mac)`

- [ ] 5.1 Generar el esqueleto: `prisma/migrations/<ts>_dedup_contract_equipment/migration.sql` (timestamp > última migración) — (Create) — 5m — dep Phase 4
- [ ] 5.2 Escribir el SQL hand-written (Decisión 6 del design): `RAISE NOTICE` conteo → window keeper por `(contractId, upper(regexp_replace(mac,'[:\-]','','g')))` (orden active>con-asset>createdAt) → merge COALESCE → repoint `replacesItemId` → DELETE losers → guard `RAISE EXCEPTION`. **SIN** `BEGIN/COMMIT` top-level (gotcha 2026-06-10) — (Modify) — 40m — dep 5.1
- [ ] 5.3 Revisar el SQL **con el usuario** (regla de oro de migraciones destructivas) — (revisión) — 15m — dep 5.2
- [ ] 5.4 Dry-run rolled-back vs prod (script de dry-run que detecta/strippea COMMIT; ver WORKFLOW) → confirmar conteo afectado y guard — (verificación) — 20m — dep 5.3
- [ ] 5.5 Commit — (git) — 2m — dep 5.4

---

## Phase 6 — Verificación final (no genera commit)
> Gates de cierre + review adversarial OBLIGATORIO.

- [ ] 6.1 `rg "from '@infrastructure" src/application/use-cases/AddContractEquipment.ts ...` → 0 (DIP) — 2m
- [ ] 6.2 `rg "AddInstalledItemManually" src/` → 0 — 2m
- [ ] 6.3 `npx tsc --noEmit` → 0 errores — 2m
- [ ] 6.4 `npm test` → 100% verde (baseline + nuevos) — 10m
- [ ] 6.5 `sdd-verify`: matriz de spec-compliance (cada scenario del spec con su test verde) — 15m
- [ ] 6.6 **Review adversarial** (foco: migración/merge · extracción dual-write/atomicidad · contrato BE↔FE 200/201/409). Loop fix→re-review hasta CLEAN — variable
- [ ] 6.7 (post-deploy) Verificación EN VIVO con Playwright: contrato 6290 → tras la migración, una sola fila por MAC; "Agregar por PPPoE" no duplica; same_type abre el modal — 20m

---

## FE companion (`ipnext-frontend` — cambio coordinado, worktree + PR aparte)
> Skill `ui-ux-pro-max`. CSS Modules + tokens `var(--color-*)`, NO Tailwind.

- [ ] FE.1 El modal de revisión del "Agregar por PPPoE" maneja el **200-enrich** (muestra "datos completados" en vez de "agregado") sin romper
- [ ] FE.2 Maneja el **409 `SAME_TYPE_NEEDS_DECISION`**: modal "Ya hay una {tipo} (SN: X). ¿Es esta? → Completar su MAC [recomendado] · Agregar nuevo" → re-POST con `completeItemId` o `force:true`
- [ ] FE.3 Test del seam (round-trip): el control manda `completeItemId`/`force` y refleja el resultado

---

## Batch Checkpoints para sdd-apply

| Batch | Fases | Condición de entrada |
|-------|-------|----------------------|
| A | Phase 0–1 | baseline verde; refactor sin cambio de comportamiento |
| B | Phase 2 | `InstallContractAsset` extraído y verde |
| C | Phase 3 | `matchEquipment` listo |
| D | Phase 4 | use case verde |
| E | Phase 5 | HTTP verde + composition-root |
| F | Phase 6 | migración revisada + dry-run OK |

---
**Phase**: sdd-tasks
**Change**: pppoe-add-dedup
**Project**: ipnext-backend
**Artifact store**: openspec
