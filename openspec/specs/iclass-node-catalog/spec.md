# Spec: IClass Node Catalog

**Capability**: `iclass-node-catalog` (NEW)
**Change**: `nodes-city-mapper` (#45)
**Summary**: Catálogo persistido de nodos IClass (los nodos SON las ciudades) con sync manual, listado admin y asignación validada a NetworkSites.

RFC 2119: MUST, MUST NOT, SHOULD, MAY.

## Entities

### `IClassNode` (persistida)

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | string uuid | PK |
| `nodeId` | int | UNIQUE — `nodeId` de IClass, clave de upsert |
| `code` | string | `codigo` trim — valor exacto para `city`/`nodeCode` |
| `description` | string | `descricao` trim |
| `active` | boolean default true | false si desapareció de IClass |
| `selectable` | boolean default true | false para agrupadores |
| `lastSyncedAt` | DateTime | — |

### Wire: item de `GET /api/admin/iclass/nodes`

`{ id, nodeId, code, description, active, selectable, lastSyncedAt: ISO-8601 }` — envuelto en `{ items: [...] }`.

## Requirements

### REQ-NCAT-1: Sync manual del catálogo

`POST /api/admin/iclass/nodes/sync` (auth requerida, mismo gate que `/so-types/sync`) MUST fetchear `iclass.listNodes()`, upsertar por `nodeId`, marcar `active=false` los ausentes y responder 200 `{ synced, created, updated, reactivated, deactivated }`. Los nodos cuyo `code` ∈ {"IPNEXT INTERNET", "Main", "Argentina"} MUST persistirse con `selectable=false`. Entradas con `code` vacío post-trim MUST descartarse.

#### Scenario: sync feliz
- GIVEN IClass devuelve 36 nodos y la tabla está vacía
- WHEN POST /nodes/sync
- THEN 200 con `created=36` AND los 3 agrupadores quedan `selectable=false`

#### Scenario: nodo desaparece
- GIVEN un nodo persistido `active=true` que IClass ya no devuelve
- WHEN POST /nodes/sync
- THEN el nodo queda `active=false` AND `deactivated=1`

#### Scenario: IClass caído
- GIVEN IClass inaccesible
- WHEN POST /nodes/sync
- THEN 502 `ICLASS_UNAVAILABLE` (mapping existente del errorHandler)

### REQ-NCAT-2: Listado del catálogo

`GET /api/admin/iclass/nodes` (auth) MUST responder 200 `{ items }` con el wire shape definido, MAY filtrar con `?active=true|false` y `?selectable=true|false` (query inválida → 400 `VALIDATION_ERROR`).

#### Scenario: filtro selectable
- GIVEN catálogo con 36 nodos, 3 con `selectable=false`
- WHEN GET /nodes?active=true&selectable=true
- THEN 200 con 33 items

### REQ-NCAT-3: Asignación validada a NetworkSite

`PUT /api/network-sites/:id` MUST aceptar `iclassNodeId: string | null`. Con uuid: MUST validar que el nodo existe (`IClassNodeNotFoundError` → 422), está `active` y `selectable` (si no → 422 `ICLASS_NODE_NOT_ASSIGNABLE`), y persistir **atómicamente** `iclassNodeCode = node.code` AND `city = node.code`. Con `null`: MUST limpiar solo `iclassNodeCode` (`city` MUST NOT cambiar). Site inexistente → 404.

#### Scenario: asignación feliz
- GIVEN nodo "Mercedes" activo y selectable
- WHEN PUT /network-sites/:id `{ iclassNodeId: "<uuid>" }`
- THEN 200 AND el site queda `iclassNodeCode="Mercedes"` AND `city="Mercedes"`

#### Scenario: nodo agrupador
- GIVEN nodo "Main" con `selectable=false`
- WHEN PUT con su `iclassNodeId`
- THEN 422 `ICLASS_NODE_NOT_ASSIGNABLE` AND el site no cambia

#### Scenario: limpiar vínculo
- GIVEN site con `iclassNodeCode="Lujan"` y `city="Lujan"`
- WHEN PUT `{ iclassNodeId: null }`
- THEN 200 AND `iclassNodeCode=null` AND `city="Lujan"` (intacto)

#### Scenario: backward compat free-text
- GIVEN un cliente viejo que manda `{ iclassNodeCode: "X" }` (sin `iclassNodeId`)
- WHEN PUT /network-sites/:id
- THEN el update parcial actual MUST seguir funcionando sin validación de catálogo

### REQ-NCAT-4: Descriptor del port con nodeId

`IClassPort.listNodes()` MUST exponer `nodeId: number` en su shape (`IClassNodeDescriptor { nodeId, code, description }`). El DTO de `GET /api/scheduling/iclass/nodes` (`iclass-nodes-endpoint`) MUST NOT cambiar.

#### Scenario: mapping del adapter
- GIVEN IClass devuelve `{ nodeId: 35270699, codigo: "Mercedes", descricao: "Mercedes" }`
- WHEN `listNodes()`
- THEN el descriptor es `{ nodeId: 35270699, code: "Mercedes", description: "Mercedes" }`

### REQ-NCAT-5: FE — select validado + sync

En `UispNodeMappingBody`, la columna "Código IClass" MUST ser un `<select>` con los nodos `active && selectable` (opción vacía = sin asignar); el cambio MUST mandar `{ iclassNodeId }` (o `null`) e invalidar `['network-sites']`. Si el `iclassNodeCode` actual no matchea ningún `code` del catálogo, el select MUST mostrar una opción deshabilitada "{code} (sin validar)". Un botón "Sincronizar desde IClass" MUST disparar el sync y mostrar el resultado. Gates: sección bajo `Can permission="uisp.read"`, ruta bajo `network.read` (idéntico a la pantalla actual — verificado).

#### Scenario: legacy sin validar
- GIVEN site con `iclassNodeCode="NODO-42"` que no existe en el catálogo
- WHEN se renderiza la fila
- THEN el select muestra "NODO-42 (sin validar)" seleccionado AND ofrece los 33 válidos

#### Scenario: asignar desde el select
- GIVEN catálogo sincronizado
- WHEN el operador elige "Chivilcoy"
- THEN PATCH con `{ iclassNodeId: <uuid de Chivilcoy> }` AND la fila muestra estado saved AND el badge readiness (#76) se recalcula con la query invalidada
