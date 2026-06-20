# Proposal: PPPoE Adoption Fixes (3 bugs de prod)

## Intent

Corregir **3 bugs** detectados en prod sobre la superficie de **adopción de inventario PPPoE** (modal InternetPanel) y **Gestión de Red**, todos surgidos al usar la feature en vivo el 2026-06-20:

1. **Placeholders en la lista de huérfanos**: la lista "Asociar PPPoE existente" muestra 10 usuarios placeholder (`accesosur1`..`accesosur10`) que NO son clientes reales.
2. **PPPoE asociado no se muestra como activo**: tras asociar un PPPoE a un contrato, el InternetPanel no lo muestra (la data está bien; el FE chequea el campo equivocado).
3. **Tab "Asignaciones" vacía**: muestra 0 asignaciones porque lee la tabla `IpAssignment` (vacía en prod) en vez de las asignaciones reales (los `PppoeService`).

## Why

- La adopción de inventario (BE+FE) ya está EN PROD, pero estos 3 bugs bloquean su uso real: el operador ve basura en la lista, no ve el PPPoE que recién asoció, y la tab de asignaciones miente con "0".
- Son bugs de **vocabulario/fuente de datos**, no de arquitectura — fixes contenidos y de bajo riesgo.

## Scope

### In Scope

**Bug 1 — filtro de placeholders (BE + data):**
- `IngestPppoeFromNas`: excluir usernames que matcheen un patrón configurable (`^accesosur\d+$`) **en el ingest** (la basura no entra a la DB).
- `ListUnassignedPppoe`: filtro secundario (defensa en profundidad) para data ya ingerida.
- Patrón configurable vía `config.ts` (`PPPOE_INGEST_EXCLUDE_PATTERN`), NO hardcodeado (es ISP-specific).
- **Data**: borrar las 10 filas `PppoeService` placeholder ya ingeridas (ops, post-deploy).

**Bug 2 — vocabulario de status (FE, 2 líneas):**
- `InternetPanel.tsx` L53 y L647: `status === 'active'` → `status === 'enabled'`. El campo `status` del `PppoeService` es `'enabled'`/`'disabled'`/`'pending'` (estado del secret RADIUS); `'active'` es el `enforcedState` (otro campo, enforcement). El FE chequea el equivocado. **CERO cambio BE.**

**Bug 3 — fuente de la tab Asignaciones (BE + FE):**
- Nuevo método de port `PppoeServiceRepository.findAssigned()` (filas con `contractId != null` AND `remoteAddress != null` AND `status='enabled'`).
- Nuevo use case `ListPppoeAssignments` → `PppoeServiceDto[]`, reemplaza la impl de `GET /api/ip-assignments`.
- FE: re-mapear columnas de la tab Asignaciones (`GestionRedPage.tsx`) a la nueva shape (username, contractId, profile en vez de poolId/clientId/servicePlanId).

### Out of Scope

- **Wave 3** (replicar a los otros ~9 routers) → change aparte.
- **Cutover al HA** → ya ejecutado y verificado (2026-06-20).
- Mostrar asignaciones DHCP / no-PPPoE en la tab → extensión futura (hoy solo PPPoE; documentado).

## Capabilities

### Modified Capabilities
- `pppoe-management` / adopción de inventario: se corrige el ingest (filtro), la lectura de asignaciones, y el display del PPPoE activo.

## Approach

1. **Bug 2 primero** (2 líneas FE, cero riesgo) — green rápido.
2. **Bug 1** — filtro en el ingest (TDD: in-memory) + config + wiring `app.ts`; luego limpieza de las 10 filas.
3. **Bug 3** — el más profundo: port `findAssigned()` (in-memory + prisma) + use case `ListPppoeAssignments` (TDD) + re-wire de la ruta + re-map de columnas FE.

## Affected Areas

| Área | Impacto |
|------|---------|
| `src/application/use-cases/IngestPppoeFromNas.ts` | Modified — filtro de exclusión + counter `excluded` |
| `src/application/use-cases/ListUnassignedPppoe.ts` | Modified — filtro secundario (defensa) |
| `src/infrastructure/config.ts` + `env.example` | Modified — `PPPOE_INGEST_EXCLUDE_PATTERN` |
| `src/domain/ports/PppoeServiceRepository.ts` | Modified — `findAssigned()` |
| `src/infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository.ts` | Modified — impl |
| `src/infrastructure/adapters/prisma/PrismaPppoeServiceRepository.ts` | Modified — impl |
| `src/application/use-cases/ListPppoeAssignments.ts` | New — use case |
| `src/infrastructure/http/routes/ipNetwork.routes.ts` | Modified — wire al nuevo use case |
| `src/infrastructure/http/app.ts` | Modified — wiring (+ composition test) |
| **FE** `src/pages/customers/tabs/contracts/InternetPanel.tsx` | Modified — 2 líneas (status) |
| **FE** `src/pages/networking/GestionRedPage.tsx` | Modified — columnas Asignaciones |
| **FE** `src/types/network.ts` | Modified — shape de `IpAssignment` |

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Cambiar la semántica de `IngestResult.skipped` | Baja | Agregar counter separado `excluded` (no conflar "ya existía" con "filtrado") |
| Reemplazar la impl de `GET /api/ip-assignments` rompe otro consumidor | Baja | Confirmar que solo la tab Asignaciones lo usa (explore: confirmado); mantener el endpoint, cambiar solo la fuente |
| El filtro `^accesosur\d+$` matchea un cliente real | Muy baja | Patrón anclado (`^...$`) + configurable; los reales tienen nombres propios (ej. `AdrianaJordalesMerc`) |
| Borrar las 10 filas placeholder borra algo en uso | Baja | Solo borrar filas `PppoeService` (inventario Prominense); NO tocar HA/router (los placeholders quedan como slots reservados) |

## Rollback

Aditivo + correcciones contenidas. Rollback = `git revert` del merge (BE y FE). El filtro del ingest es idempotente; las 10 filas borradas se re-ingieren solo si se revierte el filtro Y se re-corre el ingest.

## Dependencies

- Adopción de inventario (Fase previa) — EN PROD. Este change corrige sobre lo existente.
- Sin cambio de schema Prisma (todos los campos ya existen en `PppoeService`).

## Success Criteria

- [ ] La lista "Asociar PPPoE existente" NO muestra `accesosurN` (ni otros placeholders del patrón).
- [ ] Tras asociar un PPPoE, el InternetPanel lo muestra como activo (badge "Activo").
- [ ] La tab "Asignaciones" muestra las IPs realmente asignadas (PppoeService con contrato + IP).
- [ ] `npm test` verde (BE Jest + FE Vitest) + `tsc --noEmit` limpio en ambos repos.
- [ ] DIP preservado; composition test pinea el wiring del nuevo use case.
- [ ] Las 10 filas placeholder removidas de la DB Prominense (post-deploy, ops).
