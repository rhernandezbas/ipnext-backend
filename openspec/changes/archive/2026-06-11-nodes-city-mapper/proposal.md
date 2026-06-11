# Proposal: nodes-city-mapper (#45)

## Intent

`NetworkSite.city` es free-text manual y viaja al dispatch IClass como `address.city` y como fallback de `address.nodeCode` (`dispatchTaskToIClass.ts:119`, `IClassClient.buildServiceOrderPayload`). Un typo rompe la OS de RED. **Verificado live (2026-06-11)**: IClass NO tiene catálogo de ciudades — los nodos SON las ciudades (`GET /nodes` ≡ `GET /thirdparties/6808841/nodes`, 36 nodos, `codigo`≡`descricao`, ej. "Mercedes"; el filtro `?city=` está roto → 204). Reemplazamos el input libre por una asignación validada contra un catálogo persistido de nodos IClass, clonando el patrón `IClassSoType → Project`.

## Scope

### In Scope
- Tabla `IClassNode` + migración aditiva `20260629000000_iclass_node_catalog`.
- Port `IClassNodeRepository` + adapters `Prisma`/`InMemory` (parity).
- `IClassPort`: rename `IClassNode` → `IClassNodeDescriptor` + campo `nodeId` (el endpoint ya lo devuelve).
- Use cases: `SyncIClassNodes` (sync manual), `ListIClassNodeCatalog`, `AssignIClassNodeToNetworkSite`.
- Rutas: `POST /api/admin/iclass/nodes/sync`, `GET /api/admin/iclass/nodes` (router `iclass-admin` existente); `PUT /api/network-sites/:id` acepta `iclassNodeId`.
- FE: en `UispNodeMappingBody`, columna "Código IClass" pasa de input free-text a select del catálogo + botón "Sincronizar desde IClass".

### Out of Scope
- Cron de sync (manual, como SoTypes). Validación del catálogo en dispatch-time. Dirección (sigue manual). Limpieza server-side de `iclassNodeCode` legacy que no matchea. Search avanzado en el select (36 opciones → select nativo).

## Capabilities

### New Capabilities
- `iclass-node-catalog`: catálogo persistido de nodos IClass (sync, listado, asignación validada a NetworkSites que setea `iclassNodeCode` + `city`).

### Modified Capabilities
- None (`iclass-nodes-endpoint` no cambia: su DTO `{code, description}` queda igual; el rename del shape interno del port es implementación).

## Approach

Espejo exacto del patrón `IClassSoType`/`SyncIClassSoTypes`: sync manual upsert por `nodeId` (unique), soft-delete vía `active=false` para los que desaparecen. Los 3 nodos agrupadores no-localidad — "IPNEXT INTERNET" (35270692), "Main" (35270791), "Argentina" (35270792) — se persisten con `selectable=false` (lista hardcodeada por `code` en el use case). La asignación valida `active && selectable` y escribe `iclassNodeCode = node.code` Y `city = node.code` juntos (consistencia con el dispatch); `iclassNodeId: null` limpia solo `iclassNodeCode` (city queda — conservador).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` + migración | New | Modelo `IClassNode` |
| `src/domain/{entities,ports,errors}` | New/Mod | Entidad, port repo, `IClassNodeNotAssignableError` |
| `src/application/use-cases/` | New | 3 use cases |
| `src/infrastructure/adapters/{prisma,in-memory,iclass}` | New/Mod | Repos parity + `listNodes` con `nodeId` |
| `src/infrastructure/http/{routes,app.ts,middleware}` | Mod | iclass-admin + networkSite routes, wiring, error map |
| FE `UispNodeMappingBody` + hooks/api | Mod/New | Select + sync button |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Cache 5 min de `listNodes` sirve datos viejos al sync | Low | Aceptado y documentado (TTL corto) |
| Nuevo agrupador en IClass aparece selectable | Low | Lista hardcodeada editable; sync re-ejecutable |
| Legacy free-text que no matchea catálogo | Med | FE muestra "(sin validar)"; se corrige asignando |

## Rollback Plan

Revert del PR (BE y FE). La tabla `IClassNode` puede quedar (aditiva, sin FK desde `NetworkSite`); `iclassNodeCode`/`city` conservan los valores ya asignados — el flujo viejo (PUT free-text) sigue funcionando.

## Dependencies

- Credenciales IClass ya configuradas (mismo cliente del sync de SoTypes).

## Success Criteria

- [ ] Sync trae 36 nodos; los 3 agrupadores quedan `selectable=false`.
- [ ] Asignar un nodo setea `iclassNodeCode` y `city` con el `code` exacto del catálogo.
- [ ] Nodo inactivo/no-selectable → 422; el select FE solo ofrece válidos.
- [ ] Badge "Faltan datos IClass" (#76) se apaga al asignar (city deja de estar vacío).
