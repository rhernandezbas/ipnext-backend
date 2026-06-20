# Proposal: PPPoE ↔ Contract Integrity (3 bugs de prod)

## Intent

Reparar el invariante roto **"un contrato tiene 0 o 1 PPPoE activo, y la ficha del contrato lo refleja"**. Tres bugs de prod (2026-06-20), todos sobre `PppoeService.contractId`:

1. **#1 — el servicio de Internet NO aparece en la ficha del contrato** aunque el cliente tiene PPPoE activo: al asociar/crear un PPPoE nunca se crea la línea `ContractService` INTERNET → la sección SERVICIOS queda vacía ("Agregá un servicio").
2. **#2 — desasociar (gap)**: NO existe forma de desvincular un PPPoE de un contrato (volverlo huérfano). Hace falta para arreglar la data mala actual (2 PPPoE en el contrato de Jorge) y como operación legítima.
3. **#4 — un contrato puede tener 2 PPPoE**: una condición de carrera asoció 2 PPPoE huérfanos al mismo contrato; falta el guard "el contrato ya tiene un PPPoE".

## Why

- La adopción de inventario PPPoE está EN PROD, pero el invariante "1 internet por contrato" no se cumple (data corrupta real: contrato `02c640f0` con JorgeAnllo + JorgeVillagra).
- El operador asocia un PPPoE y la ficha del contrato sigue diciendo "Agregá un servicio" → parece que no pasó nada.
- Sin "desasociar" no se puede ni corregir la data ni mover un PPPoE.

## Scope

### In Scope

**Bug #4 — guard 1-PPPoE-por-contrato (BE):**
- Nuevo error `PppoeContractAlreadyHasServiceError` (`PPPOE_CONTRACT_ALREADY_HAS_SERVICE`, → 409).
- `AssociatePppoeToContract`: antes de asociar, `findByContract(contractId)` → si hay uno `status='enabled'`, rechazar.
- `CreatePppoeService`: cuando `contractId != null`, mismo guard antes de crear.

**Bug #2 — desasociar (BE+FE):**
- Port: `PppoeServiceRepository.clearContractId(id)` (set `contractId=null`). Impl in-memory + Prisma.
- Use case `DeassociatePppoeFromContract`: verifica pertenencia (el PPPoE es de ese contrato) → `clearContractId`. **NO toca el secret RADIUS ni el `status`** (queda `enabled`, huérfano).
- Ruta `DELETE /api/contracts/:contractId/pppoe/:pppoeId` (guard `pppoe.manage`).
- FE: `pppoeApi.deassociate` + `useDeassociatePppoe` (invalida `contract-pppoe`/`unassigned`/`client-contracts`) + botón "Desasociar" en `ActivePppoeView` (gate `pppoe.manage`).

**Bug #1 — reconcile de la línea INTERNET (BE):**
- Helper `ensureInternetContractService(contractId, active)`: resuelve catálogo `getByName('INTERNET')`; `getByPair` → si `active=true` crea/reactiva la línea (status `active`), si `active=false` la inactiva (no borra — historia preservada). **Best-effort** (si no hay catálogo INTERNET, warn + sigue; nunca rompe la asociación).
- Wire: `AssociatePppoeToContract` + `CreatePppoeService(contractId)` → `ensure(true)`; `DeassociatePppoeFromContract` + `DeactivatePppoeService` → `ensure(false)`.

**Data fix (post-deploy, ops):** desvincular los 2 PPPoE del contrato `02c640f0` (JorgeAnllo `297606e4`, JorgeVillagra `1d44bbb1`) vía el endpoint nuevo.

### Out of Scope

- **Asignaciones a escala (#3)** → Change B aparte (`asignaciones-scale`, con `ui-ux-pro-max`).
- **Mover un PPPoE** entre contratos (desasociar + re-asociar es suficiente por ahora).
- Tocar el `status` del CONTRATO (INACTIVO/activo) — viene del sync GR, fuera de scope.

## Capabilities

### Modified Capabilities
- adopción/gestión PPPoE: guard de unicidad, operación de desasociar, y reflejo en la línea INTERNET del contrato.

## Approach

1. **#4 guard** (chico, preventivo) — TDD con in-memory + `findByContract`.
2. **#2 desasociar** (port + use case + ruta + FE) — TDD.
3. **#1 reconcile INTERNET** (helper + wiring en 4 use cases) — TDD; best-effort ante catálogo faltante.
4. Deploy → data fix de los 2 Jorge → verificación en vivo.

## Affected Areas

| Área | Impacto |
|------|---------|
| `src/domain/errors/pppoe.ts` | New — `PppoeContractAlreadyHasServiceError` |
| `src/application/use-cases/AssociatePppoeToContract.ts` | Modified — guard + ensureInternet(true) |
| `src/application/use-cases/CreatePppoeService.ts` | Modified — guard + ensureInternet(true) |
| `src/domain/ports/PppoeServiceRepository.ts` | Modified — `clearContractId` |
| `src/infrastructure/adapters/{in-memory,prisma}/*PppoeServiceRepository.ts` | Modified — impl |
| `src/application/use-cases/DeassociatePppoeFromContract.ts` | New — use case |
| `src/application/use-cases/EnsureInternetContractService.ts` (helper) | New — reconcile |
| `src/application/use-cases/DeactivatePppoeService.ts` | Modified — ensureInternet(false) |
| `src/infrastructure/http/routes/pppoe.routes.ts` | Modified — DELETE deassociate + 409 mapping |
| `src/infrastructure/http/app.ts` | Modified — wiring (+ composition test) |
| **FE** `src/hooks/usePppoe.ts` | Modified — `useDeassociatePppoe` |
| **FE** `src/pages/customers/tabs/contracts/InternetPanel.tsx` | Modified — botón "Desasociar" |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| `ensureInternet` rompe la asociación si falla el catálogo | Media | **Best-effort** (try/catch + warn, patrón de `AddContractService` eventRepo); la asociación nunca falla por esto |
| El guard #4 rompe la re-asociación idempotente | Baja | Mantener el caso idempotente (mismo PPPoE→mismo contrato) ANTES del guard; el guard solo aplica a un PPPoE *distinto* |
| Desasociar deja el secret RADIUS colgado | Baja | Por diseño: desasociar = solo `contractId=null`; el PPPoE sigue `enabled` (reusable). La baja real es otro flujo |
| Guard cuenta un PPPoE `disabled`/`pending` como ocupante | Baja | El guard filtra `status='enabled'` (solo el activo ocupa el slot) |

## Rollback

Aditivo + correcciones contenidas. Rollback = `git revert` del merge (BE+FE). El reconcile INTERNET es idempotente. La data fix de los 2 Jorge es reversible (re-asociar).

## Dependencies

- Adopción de inventario (en prod). Sin cambio de schema (todos los campos existen).
- Catálogo de servicios con entrada activa `INTERNET` (ya existe; el picker usa `isInternetEntry`).

## Success Criteria

- [ ] Asociar/crear un PPPoE para un contrato → aparece el chip INTERNET en la ficha (línea `ContractService` active).
- [ ] Asociar un 2º PPPoE a un contrato que ya tiene uno activo → 409 `PPPOE_CONTRACT_ALREADY_HAS_SERVICE`.
- [ ] `DELETE /api/contracts/:cid/pppoe/:id` desvincula (contractId=null) sin tocar el secret; el PPPoE vuelve a huérfano.
- [ ] Desasociar/baja → la línea INTERNET queda `inactive` (no se borra).
- [ ] `npm test` verde (BE) + `tsc` limpio; DIP preservado; composition test.
- [ ] Los 2 PPPoE de Jorge desvinculados en prod (post-deploy).
