# Spec: IClass Task Status

**Capability**: `iclass-task-status` (NEW)
**Change**: `iclass-status-sync`
**Summary**: El estado actual de la OS de IClass persistido en la `ScheduledTask` (`iclassStatusCode` + `iclassStatusUpdatedAt`), capturado por el scheduler de cierre ANTES del filtro terminal, expuesto en el DTO de tarea como `iclassStatus` resuelto vía catálogo, y visible en FE solo cuando el estado está `tracked`.

RFC 2119: MUST, MUST NOT, SHOULD, MAY.

## Entities

### `ScheduledTask` (columnas nuevas)

| Campo | Tipo | Notas |
|-------|------|-------|
| `iclassStatusCode` | string \| null | `status.id` actual de la OS atada; null si nunca capturado |
| `iclassStatusUpdatedAt` | DateTime \| null | momento de la última transición de estado capturada |

### Wire: `iclassStatus` en el task DTO (`GET /api/scheduling/tasks` y `/:id`)

`iclassStatus: { code: string, label: string, color: string | null, tracked: boolean } | null`. `label = catalogEntry.displayLabel ?? catalogEntry.iclassLabel`. Null cuando `iclassStatusCode` es null. Si el code no está en el catálogo (carrera rara), `label = code`, `color = null`, `tracked = false`.

## Requirements

### REQ-TS-1: Captura del estado en el scheduler (pre-guard terminal)

`IngestClosedServiceOrders.processSummary` MUST, para cada SO summary cuyo `iclassCodigo` matchee una `ScheduledTask` por `sequenceNumber`, ANTES del guard `statusCode !== '7'`: (a) auto-upsertar el `statusCode`+`statusDescription` en el catálogo (REQ-SCAT-1), y (b) persistir `iclassStatusCode` en la tarea SOLO si cambió respecto del valor actual. El guard terminal MUST seguir cortando el mirror/transición/side-effects para los estados no-`'7'`. La captura MUST ser opt-in por inyección: cuando NO se inyecta el `statusCatalog`, el comportamiento legacy MUST quedar idéntico (tests existentes verdes).

#### Scenario: OS abierta puebla catálogo y tarea
- GIVEN una tarea con `sequenceNumber=1001` AND una OS con `codigo="1001"`, `statusCode="3"`, `descricao="Agendada"`
- WHEN corre `processSummary`
- THEN el catálogo tiene `statusCode="3"` (`tracked=false`) AND la tarea queda `iclassStatusCode="3"` AND el guard terminal cuenta `skippedNotClosed` (no se hace mirror)

#### Scenario: OS sin tarea no escribe nada
- GIVEN una OS con `codigo` que no matchea ninguna tarea
- WHEN corre `processSummary`
- THEN NO se upserta el catálogo NI se escribe ninguna tarea (cuenta `skippedNotOurs`)

#### Scenario: estado sin cambio es idempotente
- GIVEN la tarea ya tiene `iclassStatusCode="3"`
- WHEN `processSummary` ve la misma OS con `statusCode="3"`
- THEN NO se reescribe la tarea (sin nuevo `iclassStatusUpdatedAt`)

#### Scenario: transición de estado
- GIVEN la tarea tiene `iclassStatusCode="3"`
- WHEN `processSummary` ve la OS con `statusCode="12"`
- THEN la tarea queda `iclassStatusCode="12"` AND `iclassStatusUpdatedAt` avanza

#### Scenario: sin statusCatalog inyectado (legacy)
- GIVEN `IngestClosedServiceOrders` construido SIN `statusCatalog`
- WHEN corre `processSummary` sobre una OS no-terminal
- THEN el comportamiento es idéntico al actual (solo `skippedNotClosed`, sin tocar la tarea)

### REQ-TS-2: Resolución del estado en el DTO de tarea

El task DTO (detalle y listado) MUST incluir `iclassStatus` resuelto: cuando `iclassStatusCode` no es null, MUST buscar la entrada del catálogo y emitir `{ code, label: displayLabel ?? iclassLabel, color, tracked }`; cuando es null, `iclassStatus` MUST ser null. El listado MUST resolver en batch (sin N+1) vía `findManyByStatusCodes`.

#### Scenario: estado resuelto con displayLabel
- GIVEN la tarea tiene `iclassStatusCode="12"` AND el catálogo tiene "12" con `displayLabel="En análisis"`, `color="#FFAA00"`, `tracked=true`
- WHEN GET /api/scheduling/tasks/:id
- THEN `iclassStatus = { code: "12", label: "En análisis", color: "#FFAA00", tracked: true }`

#### Scenario: estado sin displayLabel cae a iclassLabel
- GIVEN la tarea tiene `iclassStatusCode="3"` AND el catálogo tiene "3" con `displayLabel=null`, `iclassLabel="Agendada"`
- WHEN GET /api/scheduling/tasks/:id
- THEN `iclassStatus.label = "Agendada"`

#### Scenario: tarea sin estado
- GIVEN la tarea tiene `iclassStatusCode=null`
- WHEN GET /api/scheduling/tasks/:id
- THEN `iclassStatus = null`

### REQ-TS-3: FE — badge solo para estados tracked

El FE MUST renderizar el badge del estado de IClass (usando `iclassStatus.label` y `iclassStatus.color`) en el detalle y la card del listado SOLO cuando `iclassStatus?.tracked === true`. Cuando `iclassStatus` es null o `tracked=false`, el badge MUST NOT mostrarse. El acceso a la vista MUST respetar `iclass.read` (consistente con la pantalla de tareas).

#### Scenario: badge visible
- GIVEN una tarea cuyo `iclassStatus.tracked=true`, `label="En análisis"`, `color="#FFAA00"`
- WHEN se renderiza el detalle
- THEN se muestra un badge "En análisis" con el color `#FFAA00`

#### Scenario: estado no tracked oculto
- GIVEN una tarea cuyo `iclassStatus.tracked=false`
- WHEN se renderiza el detalle o la card
- THEN NO se muestra ningún badge de estado de IClass

#### Scenario: tarea sin estado
- GIVEN `iclassStatus=null`
- WHEN se renderiza la card
- THEN NO se muestra el badge
