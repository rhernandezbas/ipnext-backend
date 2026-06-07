# Tasks — inventory-confirm-validation (#18)

Strict TDD (red→green). BE primero (fail-closed), FE después. Verify completo antes de cada deploy.

## Backend (ipnext-backend)

- [ ] **1. Error de dominio** — `src/domain/errors/inventory.ts`: `IncompleteSuggestionError(id, reason)` con `code: 'SUGGESTION_INCOMPLETE'`.

- [ ] **2. RED+GREEN — guard en `ConfirmInventorySuggestion`** (`src/__tests__/application/ConfirmInventorySuggestion.test.ts`)
  - RED: (a) DEVICE sin SN ni MAC → `execute` lanza `IncompleteSuggestionError`, NO crea item; (b) MATERIAL sin `materialDesc` → lanza, NO crea consumption; (c) `replace()` DEVICE sin SN/MAC → lanza; (d) DEVICE con SN → confirma OK; (e) MATERIAL con desc → OK (los tests actuales siguen verdes).
  - GREEN: helper privado `assertComplete(s)` (DEVICE → `serialNumber?.trim() || mac?.trim()`; MATERIAL → `materialDesc?.trim()`); llamarlo al inicio de `execute()` (tras el check de already-confirmed, antes de `getTask`) y de `replace()` (tras el check `kind !== DEVICE`).

- [ ] **3. Mapeo HTTP** — `src/infrastructure/http/middleware/errorHandler.ts`: agregar `SUGGESTION_INCOMPLETE: 422` al `statusMap`.

- [ ] **4. Verify BE** — `tsc --noEmit` (exit 0) + `npx jest --runInBand` (verde).

## Frontend (ipnext-frontend)

- [ ] **5. RED+GREEN — `SuggestionCard` bloquea la confirmación incompleta** (`SuggestionCard.test.tsx`)
  - RED: (a) DEVICE sin SN/MAC → "Confirmar" deshabilitado + hint visible, "Descartar" habilitado; (b) DEVICE con SN → "Confirmar" habilitado; (c) MATERIAL sin desc → "Confirmar" deshabilitado.
  - GREEN: flag `incomplete` (`isDevice ? (!sn?.trim() && !mac?.trim()) : !materialDesc?.trim()`); `disabled={isPending || incomplete}` en Confirmar/Agregar/Marcar-ya-instalado; hint cuando `incomplete && !resolved && canWrite`.

- [ ] **6. Verify FE** — `tsc --noEmit` (exit 0) + `npx vitest run` (verde).

## Deploy + cierre

- [ ] **7. Deploy BE** (con OK del usuario) + confirmar run en `gh`. Luego **deploy FE** (con OK) + `gh`.
- [ ] **8. Archive + docs** — `sdd-archive` (mover change a `archive/`). Commit del `BACKLOG.md`: #18 → hecho (+ el refinamiento del #19 que viaja local).
