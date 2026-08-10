# Tech Tasks Worklist Specification (Wave 1b)

## Purpose

Lista del día, detalle y transiciones de una `ScheduledTask` para el técnico autenticado. TODO el scoping viene de `req.technicianId` (nunca de body/query/params) — anti-IDOR, mismo criterio que `req.portalClientId` en `ListPortalTasks.ts`.

## Requirements

### Requirement: Task list is anchored to the token's technician

El sistema DEBE (MUST) filtrar `GET /api/tech/tasks` por `ScheduledTask.assigneeId = req.technicianId` (`schema.prisma:1379-1380`, la FK ya existe) — nunca aceptar un `technicianId`/`assigneeId` de query/body.

#### Scenario: Technician sees only their own tasks
- GIVEN la tarea `t-1` con `assigneeId='tech-A'` y `t-2` con `assigneeId='tech-B'`
- WHEN `tech-A` hace `GET /api/tech/tasks`
- THEN la respuesta incluye `t-1` y NO incluye `t-2`

### Requirement: Task detail and mutations 404 on tasks not assigned to the caller

El sistema DEBE (MUST) responder `404 TASK_NOT_FOUND` (mismo código que "no existe") cuando la tarea existe pero `assigneeId !== req.technicianId` — indistinguible, mismo criterio anti-enumeración que `GetPortalTicket` (portal-self-service, "Ticket ajeno por id").

#### Scenario: Foreign task detail is 404, not 403
- GIVEN la tarea `t-2` con `assigneeId='tech-B'`
- WHEN `tech-A` hace `GET /api/tech/tasks/t-2`
- THEN la respuesta es `404 { code: 'TASK_NOT_FOUND' }` (no `403`, no filtra que la tarea existe)

### Requirement: Field status transitions are forward-only, gated by generalStatus, and live OUTSIDE the stage workflow

El sistema DEBE (MUST) exponer un estado de campo NUEVO en columna propia sobre `ScheduledTask` — `fieldStatus: null | 'traveling' | 'on_site'` + timestamps `travelStartedAt: DateTime?` / `arrivedAt: DateTime?` — **fuera del sistema de stages** (el cron de `iclass-intermediate-states` ya auto-mueve stages desde DESLOCAMENTO/ANDAMENTO forward-only; pisarle el `stageId` a esa tarea está prohibido por diseño, ver `design.md` Decision 4).

Transición forward-only: `null → traveling → on_site`, expuesta en DOS operaciones separadas (`StartTaskTravel`, `ArriveAtTask`):
- `POST /api/tech/tasks/:id/travel/start`: `null → traveling`, sella `travelStartedAt`.
- `POST /api/tech/tasks/:id/travel/arrive`: `traveling → on_site`, sella `arrivedAt`.

Ambas transiciones son **idempotentes**: repetir la operación cuando `fieldStatus` YA está en el estado destino es un no-op `200` — NO re-sella el timestamp (misma semántica que el `retriedAt` sellado ANTES del push del guest wifi). No hay vuelta atrás en v1: pedir `travel/start` con `fieldStatus='on_site'`, o `travel/arrive` con `fieldStatus=null` (saltar el paso `traveling`), se rechaza. El cierre de la tarea NO borra `fieldStatus` — es evidencia del recorrido.

Ambas transiciones exigen `assigneeId === req.technicianId` (misma regla anti-IDOR que el resto de `/api/tech/*`: tarea ajena → `404 TASK_NOT_FOUND`, nunca `403`).

El sistema DEBE (MUST) rechazar cualquier transición de `fieldStatus` sobre una tarea cuyo `generalStatus !== 'open'`.

#### Scenario: Starting travel from the unstarted state succeeds
- GIVEN la tarea `t-1` asignada a `tech-A`, `fieldStatus=null`, `generalStatus='open'`
- WHEN `tech-A` hace `POST /api/tech/tasks/t-1/travel/start`
- THEN `fieldStatus` pasa a `'traveling'` y `travelStartedAt` queda sellado

#### Scenario: Repeating travel/start is an idempotent no-op
- GIVEN `t-1` con `fieldStatus='traveling'`, `travelStartedAt='2026-08-10T10:00:00Z'`
- WHEN `tech-A` repite `POST /api/tech/tasks/t-1/travel/start`
- THEN la respuesta es `200` con `fieldStatus='traveling'`
- AND `travelStartedAt` sigue siendo `'2026-08-10T10:00:00Z'` (NO se re-sella)

#### Scenario: Starting travel after arrival is rejected (no backward transitions)
- GIVEN `t-1` con `fieldStatus='on_site'`
- WHEN `tech-A` hace `POST /api/tech/tasks/t-1/travel/start`
- THEN `409 { code: 'INVALID_FIELD_STATUS_TRANSITION' }`

#### Scenario: Arriving without having started travel is rejected (no skipping)
- GIVEN `t-1` con `fieldStatus=null`
- WHEN `tech-A` hace `POST /api/tech/tasks/t-1/travel/arrive` directo
- THEN `409 { code: 'INVALID_FIELD_STATUS_TRANSITION' }`

#### Scenario: Arriving transitions traveling to on_site
- GIVEN `t-1` con `fieldStatus='traveling'`
- WHEN `tech-A` hace `POST /api/tech/tasks/t-1/travel/arrive`
- THEN `fieldStatus` pasa a `'on_site'` y `arrivedAt` queda sellado

#### Scenario: Transition on a closed task is rejected
- GIVEN `t-1` con `generalStatus='closed'`
- WHEN `tech-A` intenta `travel/start` o `travel/arrive`
- THEN `409 { code: 'TASK_ALREADY_CLOSED' }`

### Requirement: Closing validates the result code against the IClass catalog

El sistema DEBE (MUST) validar `resultCode` contra `IClassResultCodeRepository.findByCode` (mismo port que usa `CloseIClassServiceOrder.ts:75`, catálogo `IClassResultCode`, `schema.prisma:861`) antes de cerrar. Un código inexistente en el catálogo se rechaza.

#### Scenario: Unknown result code is rejected
- GIVEN el catálogo NO tiene `resultCode='CODIGO-INVENTADO'`
- WHEN `tech-A` hace `POST /api/tech/tasks/t-1/close { resultCode: 'CODIGO-INVENTADO', comment: '...' }`
- THEN `404 { code: 'ICLASS_RESULT_CODE_NOT_FOUND' }`

### Requirement: Closure from the app is first-writer-wins and visible to the technician

El cierre DEBE (MUST) usar el mismo guard atómico de `task-general-status` (ver delta spec de esa capability) con `closureOrigin='app'`. Si otro origen (`iclass`|`staff`) ya cerró la tarea primero, el técnico DEBE (MUST) recibir una respuesta que se lo diga explícitamente — nunca un 200 silencioso que sugiera que su cierre ganó.

#### Scenario: Technician's close loses the race
- GIVEN `t-1` fue cerrada por `iclass` un instante antes (`closureOrigin='iclass'`)
- WHEN `tech-A` hace `POST /api/tech/tasks/t-1/close { resultCode: 'X', comment: '...' }` casi al mismo tiempo
- THEN la respuesta es `409 { code: 'TASK_ALREADY_CLOSED', closureOrigin: 'iclass' }`
- AND `t-1.generalStatus` sigue `'closed'` con el resultado que puso `iclass`, NUNCA sobreescrito por el intento del técnico

## HTTP Contract

### GET /api/tech/tasks?date=YYYY-MM-DD
`date` opcional, default hoy (America/Argentina/Buenos_Aires, mismo criterio que `ListPortalTasks`/`portalTask.dto.ts`). Filtra por `startDate` en esa fecha, `assigneeId = req.technicianId`, `generalStatus IN ('open')` por defecto.

Response `200`: `{ data: TechTaskListItemDto[] }`

```ts
interface TechTaskListItemDto {
  id: string;                 // ScheduledTask.id
  sequenceNumber: number;     // existe
  title: string;               // existe
  address: string | null;      // existe
  lat: number | null;          // existe
  lng: number | null;          // existe
  customerName: string | null; // NUEVO — join a Client, no expuesto hoy en ningún DTO de tech
  priority: string;            // existe
  category: string;            // existe
  startDate: string | null;    // existe, ISO
  generalStatus: 'open' | 'closed' | 'dismissed'; // existe
  fieldStatus: 'traveling' | 'on_site' | null; // NUEVO campo (migración aditiva), columna propia fuera de stages — null = no arrancó el trayecto
  iclassOrderCode: string | null; // existe
}
```

### GET /api/tech/tasks/:id
Response `200`: `TechTaskDetailDto` = `TechTaskListItemDto` + `{ description: string | null; notes: string | null; endDate: string | null; estimatedHours: number; closureOrigin: 'app' | 'iclass' | 'staff' | null; travelStartedAt: string | null; arrivedAt: string | null }` (`description`/`notes`/`endDate`/`estimatedHours` existen; `closureOrigin`, `travelStartedAt`, `arrivedAt` son NUEVOS, `closureOrigin` ver delta de `task-general-status`).
Errors: `404 { code: 'TASK_NOT_FOUND' }`

### POST /api/tech/tasks/:id/travel/start
Sin body. Transición `null → traveling`, sella `travelStartedAt`. Idempotente si `fieldStatus` ya es `'traveling'` (no re-sella).
Response `200`: `TechTaskDetailDto` actualizado.
Errors:
| Status | code |
|---|---|
| 404 | `TASK_NOT_FOUND` |
| 409 | `INVALID_FIELD_STATUS_TRANSITION` (`fieldStatus` ya es `'on_site'`) |
| 409 | `TASK_ALREADY_CLOSED` |

### POST /api/tech/tasks/:id/travel/arrive
Sin body. Transición `traveling → on_site`, sella `arrivedAt`. Idempotente si `fieldStatus` ya es `'on_site'` (no re-sella).
Response `200`: `TechTaskDetailDto` actualizado.
Errors:
| Status | code |
|---|---|
| 404 | `TASK_NOT_FOUND` |
| 409 | `INVALID_FIELD_STATUS_TRANSITION` (`fieldStatus` es `null`, saltea el paso `traveling`) |
| 409 | `TASK_ALREADY_CLOSED` |

### POST /api/tech/tasks/:id/close
Body: `{ resultCode: string, comment: string }`
Response `200`: `TechTaskDetailDto` con `generalStatus='closed'`, `closureOrigin='app'`.
Errors:
| Status | code | Body extra |
|---|---|---|
| 400 | `VALIDATION_ERROR` | falta `resultCode` o `comment` |
| 404 | `TASK_NOT_FOUND` | — |
| 404 | `ICLASS_RESULT_CODE_NOT_FOUND` | — |
| 409 | `TASK_ALREADY_CLOSED` | `{ closureOrigin: 'iclass' \| 'staff' \| 'app' }` |

**Resuelto en sdd-design** (ya no es incógnita): el campo `fieldStatus` y los endpoints `/travel/start` y `/travel/arrive` son diseño nuevo — no existen hoy en el repo — pero su modelo de datos quedó fijado en `design.md` Decision 4: columna propia `fieldStatus: null | 'traveling' | 'on_site'` + `travelStartedAt`/`arrivedAt`, deliberadamente FUERA del sistema de stages (colisión con el cron de `iclass-intermediate-states`, que ya auto-mueve stages forward-only).

**NO VERIFICADO CONTRA CÓDIGO** (diseño nuevo, sin resolver): `customerName` en el DTO de lista requiere un JOIN a `Client` que `ListPortalTasks`/`PortalTaskDto` NO expone (ese DTO es deliberadamente mínimo, sin cliente) — se modela nuevo para tech, no reuso literal.

## Aditivo, solo-crece
Todo campo nuevo se agrega, nunca se renombra ni se borra.
