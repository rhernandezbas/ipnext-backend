# Design: nodes-city-mapper (#45)

## Technical Approach

Clon 1:1 del patrón `IClassSoType` (entidad+port+sync+assign+routes admin), con upsert por `nodeId` (int, único — los `code` podrían en teoría colisionar) y columna extra `selectable` para los 3 agrupadores. La asignación reusa el patrón de `projects.routes.ts` PUT (delegación condicional si el campo está presente en el body).

## Architecture Decisions

| Decisión | Alternativas | Elección + rationale |
|----------|--------------|----------------------|
| Nombre del shape del port | Entidad `IClassNodeCatalogEntry` | **Rename `IClassNode` → `IClassNodeDescriptor` en `IClassPort`** y liberar `IClassNode` para la entidad persistida. Parity exacta con `IClassSoTypeDescriptor`/`IClassSoType`. Rename mecánico: `IClassPort.ts`, `IClassClient.ts`, `InMemoryIClassClient.ts`, `ListIClassNodes.ts` + tests |
| Agrupadores | Excluirlos del sync | **Columna `selectable=false`** seteada en sync desde constante `NON_SELECTABLE_NODE_CODES = ['IPNEXT INTERNET','Main','Argentina']` en `SyncIClassNodes.ts`. Mantiene espejo completo (audit), igual de simple |
| Ruta del catálogo | Router nuevo `/api/iclass` | **Extender `createIClassAdminRouter`** (ya montado en `/api/admin/iclass`, auth incluida) — cero wiring de mount nuevo |
| Asignación | PATCH dedicado | **`PUT /api/network-sites/:id` con `iclassNodeId`** — el FE ya pega ahí (`patchNetworkSite` → PUT); mismo patrón que `iclassSoTypeId` en projects |
| `null` en asignación | Limpiar code+city | **Limpia solo `iclassNodeCode`**; `city` queda (conservador, no rompe readiness ni dispatch de sites ya configurados) |
| Naming timestamp | `syncedAt` | **`lastSyncedAt`** — parity con `IClassSoType` |
| Errores | Error nuevo not-found | **Reusar `IClassNodeNotFoundError`** (ya mapea `ICLASS_NODE_NOT_FOUND: 422`); nuevo `IClassNodeNotAssignableError` → `ICLASS_NODE_NOT_ASSIGNABLE: 422` en `errorHandler.ts` (cubre inactive y no-selectable, con reason en el mensaje) |

## Data Flow

```
[FE botón Sincronizar] → POST /api/admin/iclass/nodes/sync
  → SyncIClassNodes → IClassPort.listNodes() (cache 5min ok)
  → IClassNodeRepository.upsertByNodeId() ×N → markInactiveExcept(nodeIds)

[FE select fila] → PUT /api/network-sites/:id {iclassNodeId}
  → AssignIClassNodeToNetworkSite → nodes.getById → guard active&&selectable
  → networkSites.update(id, { iclassNodeCode: code, city: code })

[Dispatch sin cambios] effectiveCity = networkSite.city → ya validado
```

## Schema / Migración

`prisma/migrations/20260629000000_iclass_node_catalog/migration.sql` — aditiva, sin BEGIN/COMMIT (Prisma envuelve cada migración):

```sql
CREATE TABLE "IClassNode" (
    "id" TEXT NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "selectable" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IClassNode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IClassNode_nodeId_key" ON "IClassNode"("nodeId");
CREATE INDEX "IClassNode_active_idx" ON "IClassNode"("active");
```

Sin FK desde `NetworkSite` (sin cambio de schema ahí — se escriben las columnas existentes `iclassNodeCode`/`city`).

## File Changes — BE

| File | Action | Qué |
|------|--------|-----|
| `src/domain/entities/iclass-node.ts` | Create | Entidad `IClassNode` |
| `src/domain/ports/IClassNodeRepository.ts` | Create | `list({active?,selectable?})`, `getById`, `upsertByNodeId({nodeId,code,description,selectable})→{status}`, `markInactiveExcept(nodeIds:number[])→number` |
| `src/domain/ports/IClassPort.ts` | Modify | `IClassNodeDescriptor { nodeId:number; code; description }` (rename + campo) |
| `src/domain/errors/iclass.ts` | Modify | `IClassNodeNotAssignableError(code, reason)` |
| `src/application/use-cases/SyncIClassNodes.ts` | Create | fetch→upsert→markInactive; constante agrupadores |
| `src/application/use-cases/ListIClassNodeCatalog.ts` | Create | wrapper `repo.list(filter)` (nombre distinto del existente `ListIClassNodes`, que es live) |
| `src/application/use-cases/AssignIClassNodeToNetworkSite.ts` | Create | guard + `networkSites.update(id, {iclassNodeCode, city})` |
| `src/infrastructure/adapters/prisma/PrismaIClassNodeRepository.ts` | Create | upsert por `nodeId` |
| `src/infrastructure/adapters/in-memory/InMemoryIClassNodeRepository.ts` | Create | parity |
| `src/infrastructure/adapters/iclass/IClassClient.ts` | Modify | `listNodes` mapea `nodeId: Number(o.nodeId)` |
| `src/infrastructure/adapters/in-memory/InMemoryIClassClient.ts` | Modify | stub con `nodeId` |
| `src/infrastructure/http/routes/iclass-admin.routes.ts` | Modify | `POST /nodes/sync`, `GET /nodes` (zod query `active`/`selectable`, mapping a ISO igual que so-types) — firma +2 use cases |
| `src/infrastructure/http/routes/networkSite.routes.ts` | Modify | en PUT: si `'iclassNodeId' in body` → assign; si solo eso, return; resto → `updateNetworkSite` con el body sin `iclassNodeId` (patrón projects.routes PUT) |
| `src/infrastructure/http/middleware/errorHandler.ts` | Modify | `ICLASS_NODE_NOT_ASSIGNABLE: 422` |
| `src/infrastructure/http/app.ts` | Modify | ver wiring |
| `prisma/schema.prisma` + migración | Modify/Create | modelo arriba |

**Wiring exacto app.ts**: junto al bloque so-types (~L1342): `const iclassNodeRepo = new PrismaIClassNodeRepository(); const syncIClassNodes = new SyncIClassNodes(buildIClassClient(), iclassNodeRepo); const listIClassNodeCatalog = new ListIClassNodeCatalog(iclassNodeRepo);` → pasar a `createIClassAdminRouter(...)` (~L1443). Junto a network-sites (~L950): `const assignIClassNodeToNetworkSite = new AssignIClassNodeToNetworkSite(networkSiteRepo, iclassNodeRepo);` → param nuevo (opcional, al final) de `createNetworkSiteRouter` (~L1388). Nota orden: `iclassNodeRepo` debe declararse antes de L950 o mover la creación — verificar en apply.

## File Changes — FE

| File | Action | Qué |
|------|--------|-----|
| `src/types/iclassNode.ts` | Create | `IClassNode` wire type |
| `src/api/iclassNodes.api.ts` | Create | `BASE='/admin/iclass/nodes'`: `getIClassNodes()`, `syncIClassNodes()` |
| `src/hooks/useIClassNodes.ts` | Create | `useIClassNodes()` (queryKey `['iclass-nodes']`, filtra active+selectable), `useSyncIClassNodes()` (invalida `['iclass-nodes']`) |
| `src/components/networking/UispNodeMappingBody.tsx` | Modify | input → select nativo (value = uuid del nodo matcheado por `code`; legacy no-match → option disabled "{code} (sin validar)"); change → `patch.mutateAsync({id, data:{iclassNodeId}})` (invalida `['network-sites']` vía hook existente); botón "Sincronizar desde IClass" en toolbar con resultado inline/toast |
| `src/types/networkSite.ts` | Modify | `iclassNodeId?: string \| null` solo en payload de patch (no viene en GET) |

Permisos FE (verificado): ruta `network.read` (`App.tsx:234`), sección `Can uisp.read` — sin cambios.

## Testing Strategy (STRICT TDD — red→green→refactor)

| Capa | Test | Aproximación |
|------|------|--------------|
| BE unit | `SyncIClassNodes.test.ts` | InMemory client+repo: created/updated/reactivated/deactivated, agrupadores selectable=false, code vacío descartado |
| BE unit | `AssignIClassNodeToNetworkSite.test.ts` | setea ambos campos; null limpia solo code; not-found/inactive/no-selectable → errores |
| BE unit | `InMemoryIClassNodeRepository.test.ts` | contrato del port |
| BE routes | `iclassNodes.routes.test.ts` (supertest, in-memory) | GET filtros + shape ISO, POST sync, 400 query inválida |
| BE routes | `networkSite.routes` (extender) | PUT con `iclassNodeId` happy/null/422; backward-compat free-text |
| BE composición | test composition-root (patrón `projects-composition.test.ts`) | app monta rutas nuevas con wiring real |
| FE | `UispNodeMappingBody.nodeSelect.test.tsx` | select con catálogo, change → PATCH `{iclassNodeId}`, legacy "(sin validar)", sync button → POST + feedback |

## Migration / Rollout

Deploy **BE primero** (migración aditiva + endpoints; el PUT sigue aceptando `iclassNodeCode` free-text → FE viejo no rompe), después FE. Post-deploy: operador corre "Sincronizar" y reasigna los sites "(sin validar)". Rollback: revert FE (vuelve el input); BE puede quedar.

## Open Questions

- [ ] Cache 5 min de `listNodes()`: ¿bypass en sync? Default: aceptarlo (TTL corto, sync manual).
- [ ] Ninguna bloqueante.
