# Spec: IClass Status Catalog

**Capability**: `iclass-status-catalog` (NEW)
**Change**: `iclass-status-sync`
**Summary**: Catálogo persistido de estados de IClass con auto-discovery (auto-upsert del statusCode opaco observado), sync manual, listado/edición admin (`displayLabel`, `color`, `tracked`) y resolución de etiqueta al leer.

RFC 2119: MUST, MUST NOT, SHOULD, MAY.

## Entities

### `IClassStatusCatalogEntry` (persistida)

| Campo | Tipo | Notas |
|-------|------|-------|
| `id` | string uuid | PK |
| `statusCode` | string | UNIQUE — `status.id` opaco de IClass, clave de upsert |
| `iclassLabel` | string | `status.descricao` crudo del último visto (se refresca en cada upsert) |
| `displayLabel` | string \| null | etiqueta Prominense editable; NULL = usar `iclassLabel` |
| `color` | string \| null | hex `#RRGGBB` opcional para el badge |
| `tracked` | boolean default false | opt-in del operador al seguimiento/visibilidad en el FE |
| `lastSyncedAt` | DateTime | última vez visto/sincronizado |

### Wire: item de `GET /api/admin/iclass/statuses`

`{ statusCode, iclassLabel, displayLabel, effectiveLabel, color, tracked, lastSyncedAt: ISO-8601 }` envuelto en `{ items: [...] }`. `effectiveLabel = displayLabel ?? iclassLabel`.

## Requirements

### REQ-SCAT-1: Auto-discovery del statusCode (upsert pasivo)

El upsert del catálogo MUST ser por `statusCode` (UNIQUE). Al upsertar un `statusCode` ya existente, MUST refrescar `iclassLabel` y `lastSyncedAt` pero MUST NOT pisar `displayLabel`, `color` ni `tracked` (la config del operador se preserva). Una entrada nueva MUST crearse con `tracked=false`, `displayLabel=null`, `color=null`.

#### Scenario: statusCode nuevo
- GIVEN el catálogo no tiene `statusCode="12"`
- WHEN se upserta `{ statusCode: "12", iclassLabel: "Em Análise" }`
- THEN se crea con `tracked=false`, `displayLabel=null`, `color=null` AND el resultado es `created`

#### Scenario: statusCode existente preserva config
- GIVEN existe `statusCode="12"` con `displayLabel="En análisis"`, `color="#FFAA00"`, `tracked=true`
- WHEN se upserta `{ statusCode: "12", iclassLabel: "Em Análise (alt)" }`
- THEN `iclassLabel` pasa a "Em Análise (alt)" AND `displayLabel`/`color`/`tracked` quedan intactos AND el resultado es `updated`

### REQ-SCAT-2: Sync manual del catálogo

`POST /api/admin/iclass/statuses/sync` (auth + `iclass.manage`) MUST listar las OS recientes vía `iclass.listServiceOrders()` sobre la ventana de descubrimiento (~28 días, bajo el cap de 30 de IClass), juntar los `statusCode` distintos con su `descricao`, upsertarlos (REQ-SCAT-1) y responder 200 `{ synced, created, updated }`. `statusCode` vacío post-trim MUST descartarse.

#### Scenario: sync descubre estados
- GIVEN IClass devuelve OS con statusCodes {"3","7","12"} y el catálogo está vacío
- WHEN POST /statuses/sync
- THEN 200 con `created=3` AND cada entrada queda `tracked=false`

#### Scenario: sync re-ejecutado preserva config
- GIVEN el operador ya marcó `statusCode="12"` como `tracked=true`
- WHEN POST /statuses/sync vuelve a ver "12"
- THEN queda `updated` AND `tracked=true` se preserva

#### Scenario: IClass caído
- GIVEN IClass inaccesible
- WHEN POST /statuses/sync
- THEN 502 `ICLASS_UNAVAILABLE` (mapping existente del errorHandler)

### REQ-SCAT-3: Listado del catálogo

`GET /api/admin/iclass/statuses` (auth + `iclass.read`) MUST responder 200 `{ items }` con el wire shape definido (incluyendo `effectiveLabel`). Sin `iclass.read` → 403.

#### Scenario: listado con effectiveLabel
- GIVEN `statusCode="3"` con `displayLabel=null`, `iclassLabel="Agendada"` AND `statusCode="12"` con `displayLabel="En análisis"`
- WHEN GET /statuses
- THEN el item "3" trae `effectiveLabel="Agendada"` AND el item "12" trae `effectiveLabel="En análisis"`

#### Scenario: sin permiso de lectura
- GIVEN un usuario sin `iclass.read`
- WHEN GET /statuses
- THEN 403

### REQ-SCAT-4: Edición de la config del estado

`PATCH /api/admin/iclass/statuses/:statusCode` (auth + `iclass.manage`) MUST aceptar un patch parcial `{ displayLabel?, color?, tracked? }`, persistirlo y responder 200 con la entrada actualizada. `statusCode` inexistente → 404 `ICLASS_STATUS_NOT_FOUND`. Body inválido (color no-hex, tracked no-bool) → 400 `VALIDATION_ERROR`.

#### Scenario: togglear tracked
- GIVEN `statusCode="12"` con `tracked=false`
- WHEN PATCH /statuses/12 `{ tracked: true }`
- THEN 200 AND la entrada queda `tracked=true` AND `displayLabel`/`color` sin cambios

#### Scenario: editar etiqueta y color
- GIVEN `statusCode="12"`
- WHEN PATCH /statuses/12 `{ displayLabel: "En análisis", color: "#FFAA00" }`
- THEN 200 AND `effectiveLabel="En análisis"` AND `color="#FFAA00"`

#### Scenario: estado inexistente
- GIVEN no existe `statusCode="999"`
- WHEN PATCH /statuses/999 `{ tracked: true }`
- THEN 404 `ICLASS_STATUS_NOT_FOUND`

### REQ-SCAT-5: Resolución batch para el read-path de tareas

El repo MUST exponer una resolución batch `findManyByStatusCodes(codes[])` que devuelva las entradas de los códigos pedidos en una sola query, para que el listado de tareas resuelva `iclassStatus` sin N+1.

#### Scenario: resolución batch
- GIVEN el catálogo tiene "3" y "7"
- WHEN se piden `["3","7","999"]`
- THEN devuelve las 2 existentes AND omite "999" (no error)
