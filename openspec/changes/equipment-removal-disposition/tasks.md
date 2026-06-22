# Tasks: equipment-removal-disposition (Cambio B)

> Estricto TDD. Gate (suite + `tsc`) corrido por el orquestador. Worktree `ipnext-backend/.claude/worktrees/equipment-removal-disposition-be`. FE coordinado en `ipnext-frontend` (worktree+PR aparte). **Sin migración.**

## Phase 0 — Baseline
- [ ] 0.1 `npm test` + `tsc --noEmit` en main → baseline verde — 10m
- [ ] 0.2 Confirmar en apply: ¿hay `users.findById` para validar `technicianId`? (open question #1 del design) — 5m

## Phase 1 — Commit 1: `RouteAssetToDisposition` (servicio, TDD)
> Gate: tests del servicio verdes. Commit: `feat(inventory): RouteAssetToDisposition routes asset by removal destination`
- [ ] 1.1 **RED** `src/__tests__/application/RouteAssetToDisposition.test.ts`: las 5 dispositions (estado/ubicación/movimiento esperados de la tabla del design) + CLIENTE→TECNICO + note en el movimiento — (Create) — 40m
- [ ] 1.2 **GREEN** `src/application/services/RouteAssetToDisposition.ts`: `execute(b, {assetId, disposition, contractId, technicianId?, note?})` → `updateStatus(nextStatus(...))` + `updateLocation` (si cambia) + `movements.record({type, from, to, technicianId?, source:'OPERATOR_RETIRE', note, status})`. Reusa `Resolve{Depot,Technician,Client}Location` — (Create) — 35m
- [ ] 1.3 DIP: `rg "from '@infrastructure" src/application/services/RouteAssetToDisposition.ts` → 0 — 2m
- [ ] 1.4 Gate + commit — 10m

## Phase 2 — Commit 2: `RetireInstalledItem` (use case, TDD)
> Gate: tests del use case verdes + suite. Commit: `feat(inventory): RetireInstalledItem (remove with destination)`
- [ ] 2.1 Errores `TechnicianRequiredError` (+ `InvalidDispositionError` si hace falta) en `src/domain/errors/inventory.ts` — 10m
- [ ] 2.2 **RED** `src/__tests__/application/RetireInstalledItem.test.ts`: 5 dispositions felices, TECNICO sin technicianId → error, item de otro contrato → NotFound, item ya removed → no-op (sin doble movimiento), legacy sin assetId → solo soft-delete, atomicidad (rollback) — (Create) — 45m
- [ ] 2.3 **GREEN** `src/application/use-cases/RetireInstalledItem.ts` (flujo de Decisión 3 del design, `runUnit`, deps W1 opcionales) — (Create) — 35m
- [ ] 2.4 Gate + commit — 10m

## Phase 3 — Commit 3: HTTP wiring
> Gate: tests de ruta + composition-root + suite. Commit: `feat(http): wire POST inventory retire (remove with destination)`
- [ ] 3.1 **RED** extender `inventory.routes`/`serviceInventory.routes` test: POST `/:itemId/retire` → 200 por disposition, 400 sin disposition, 400 TECNICO sin tech, 404 cross-contrato — 30m
- [ ] 3.2 **GREEN** zod `{ disposition enum, technicianId?, note? }` con refine (technicianId requerido sii TECNICO); ruta llama `RetireInstalledItem`; mapear errores (`TechnicianRequiredError`→400, `InstalledItemNotFoundError`→404) — `contractInventory.routes.ts` (Modify) — 25m
- [ ] 3.3 Wire en `app.ts` (deps W1 + `RouteAssetToDisposition`) — (Modify) — 15m
- [ ] 3.4 Composition-root test: el POST retire corre con el routing (assets/movements/uow inyectados) — 15m
- [ ] 3.5 Gate + commit — 10m

## Phase 4 — Verificación final
- [ ] 4.1 `rg "from '@infrastructure" src/application/{use-cases/RetireInstalledItem,services/RouteAssetToDisposition}.ts` → 0 — 2m
- [ ] 4.2 `tsc --noEmit` 0 + `npm test` 100% verde — 10m
- [ ] 4.3 `sdd-verify`: cada scenario del spec con su test verde — 10m
- [ ] 4.4 Review adversarial (foco: el path CLIENTE→TECNICO · atomicidad · transiciones de estado · contrato BE↔FE) → loop hasta CLEAN — variable

## FE companion (`ipnext-frontend` — worktree+PR aparte, `ui-ux-pro-max`)
- [ ] FE.1 Modal de destino: 5 radios; si "Con técnico" → dropdown con `GET /inventory/technicians`; textarea nota opcional. Reemplaza el `confirm` de "Quitar" en `ServiceInventorySection.tsx`
- [ ] FE.2 API `retireInstalledItem(contractId, itemId, {disposition, technicianId?, note?})` (POST) + mutation + invalidación
- [ ] FE.3 Submit deshabilitado si TECNICO sin técnico (espeja el BE). CSS Modules + tokens.
- [ ] FE.4 Tests Vitest del seam (cada disposition manda el body correcto; TECNICO exige técnico)

## Batch Checkpoints
| Batch | Fases | Entrada |
|-------|-------|---------|
| A | 0–1 | baseline + servicio de routing |
| B | 2 | use case |
| C | 3–4 | HTTP + verify + review |

---
**Phase**: sdd-tasks · **Change**: equipment-removal-disposition · **Project**: ipnext-backend · **Artifact store**: openspec
