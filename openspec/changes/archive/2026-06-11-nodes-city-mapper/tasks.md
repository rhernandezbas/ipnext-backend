# Tasks: nodes-city-mapper (#45) — IClass Node Catalog

## Phase 1: DB + Domain Foundation

- [x] 1.1 [RED] `src/domain/entities/iclass-node.ts` — crear entidad `IClassNode` con campos del spec; test unitario en `__tests__/domain/iclass-node.test.ts`
- [x] 1.2 [GREEN] crear `src/domain/ports/IClassNodeRepository.ts` — interfaz con `list({active?,selectable?})`, `getById`, `upsertByNodeId`, `markInactiveExcept`
- [x] 1.3 [GREEN] `prisma/schema.prisma` — agregar modelo `IClassNode` (nodeId unique, selectable, lastSyncedAt)
- [x] 1.4 [GREEN] crear migración `prisma/migrations/20260629000000_iclass_node_catalog/migration.sql` (sin BEGIN/COMMIT; indexes active+nodeId)
- [x] 1.5 [GREEN] `src/domain/errors/iclass.ts` — agregar `IClassNodeNotAssignableError(code, reason)`
- [x] 1.6 [GREEN] `src/infrastructure/http/middleware/errorHandler.ts` — mapear `ICLASS_NODE_NOT_ASSIGNABLE → 422`
- [x] 1.7 [GREEN] `src/domain/ports/IClassPort.ts` — rename `IClassNode → IClassNodeDescriptor`; agregar `nodeId: number`

## Phase 2: Adapters + Rename mecánico

- [x] 2.1 [RED] `src/__tests__/infrastructure/InMemoryIClassNodeRepository.test.ts` — contrato del port (list filters, upsert, markInactive)
- [x] 2.2 [GREEN] `src/infrastructure/adapters/in-memory/InMemoryIClassNodeRepository.ts` — implementación in-memory del port
- [x] 2.3 [GREEN] `src/infrastructure/adapters/prisma/PrismaIClassNodeRepository.ts` — upsert por `nodeId`, `markInactiveExcept`
- [x] 2.4 [GREEN] `src/infrastructure/adapters/iclass/IClassClient.ts` — `listNodes` mapea `nodeId: Number(o.nodeId)`
- [x] 2.5 [GREEN] `src/infrastructure/adapters/in-memory/InMemoryIClassClient.ts` — stub con `nodeId` en fixtures
- [x] 2.6 [GREEN] rename `IClassNode → IClassNodeDescriptor` en `ListIClassNodes.ts` + sus tests (mecánico, sin cambio de lógica)

## Phase 3: Use Cases (TDD estricto)

- [x] 3.1 [RED] `src/__tests__/application/SyncIClassNodes.test.ts` — escenarios: created/updated/reactivated/deactivated, agrupadores selectable=false, code vacío descartado, IClass caído → error
- [x] 3.2 [GREEN] `src/application/use-cases/SyncIClassNodes.ts` — fetch→upsert→markInactive; constante `NON_SELECTABLE_NODE_CODES`
- [x] 3.3 [RED] `src/__tests__/application/AssignIClassNodeToNetworkSite.test.ts` — happy path, null limpia solo code, not-found/inactive/no-selectable → errores correctos
- [x] 3.4 [GREEN] `src/application/use-cases/AssignIClassNodeToNetworkSite.ts` — guard active&&selectable; update `{iclassNodeCode, city}`; null → solo `iclassNodeCode=null`
- [x] 3.5 [GREEN] `src/application/use-cases/ListIClassNodeCatalog.ts` — wrapper `repo.list(filter)`

## Phase 4: Routes + Wiring

- [x] 4.1 [RED] `src/__tests__/infrastructure/routes/iclassNodes.routes.test.ts` (supertest, in-memory) — GET filtros + shape ISO, POST sync 200 counts, 400 query inválida, 502 IClass caído
- [x] 4.2 [GREEN] `src/infrastructure/http/routes/iclass-admin.routes.ts` — agregar `POST /nodes/sync` y `GET /nodes` (zod query active/selectable); firmar +2 use cases
- [x] 4.3 [RED] extender `src/__tests__/infrastructure/routes/networkSite.routes.test.ts` — PUT con `iclassNodeId` happy/null/422; backward-compat free-text sin `iclassNodeId`
- [x] 4.4 [GREEN] `src/infrastructure/http/routes/networkSite.routes.ts` — delegación condicional: si `'iclassNodeId' in body` → AssignIClassNodeToNetworkSite; resto → updateNetworkSite (patrón projects.routes)
- [x] 4.5 [RED] test composition-root (`src/__tests__/app-composition.iclassNodes.test.ts`, patrón projects) — app monta rutas `/api/admin/iclass/nodes` y acepta `iclassNodeId` en PUT network-sites
- [x] 4.6 [GREEN] `src/infrastructure/http/app.ts` — wiring: `iclassNodeRepo`, `syncIClassNodes`, `listIClassNodeCatalog`, `assignIClassNodeToNetworkSite`; pasar a routers correspondientes

## Phase 5: Frontend (wire contract frozen)

- [ ] 5.1 `src/types/iclassNode.ts` — crear tipo wire `IClassNode { id, nodeId, code, description, active, selectable, lastSyncedAt }`
- [ ] 5.2 `src/types/networkSite.ts` — agregar `iclassNodeId?: string | null` solo al payload de patch
- [ ] 5.3 `src/api/iclassNodes.api.ts` — `getIClassNodes()` y `syncIClassNodes()` bajo `BASE='/admin/iclass/nodes'`
- [ ] 5.4 `src/hooks/useIClassNodes.ts` — `useIClassNodes()` (queryKey `['iclass-nodes']`, filtra active+selectable); `useSyncIClassNodes()` (invalida `['iclass-nodes']`)
- [ ] 5.5 [RED] `src/__tests__/components/UispNodeMappingBody.nodeSelect.test.tsx` (vitest) — select con catálogo, change → PATCH `{iclassNodeId}`, legacy "(sin validar)", sync button → POST + toast counts
- [ ] 5.6 [GREEN] `src/components/networking/UispNodeMappingBody.tsx` — input→select nativo (value=uuid por code match; legacy→option disabled); change invalida `['network-sites']`; botón "Sincronizar desde IClass" con toast resultado
