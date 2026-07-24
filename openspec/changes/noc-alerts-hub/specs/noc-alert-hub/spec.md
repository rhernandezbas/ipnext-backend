# Noc Alert Hub Specification

## Purpose

Fundación del hub unificado de alertas NOC: entidad `NocAlert` (nueva, tabla
propia, no reusa `MonitoringAlert`/`Notification`), ingesta genérica por
fuente, ciclo de vida firing/resolved con dedup por `(source, fingerprint)`,
ACK con MTTA y lectura filtrada. **Arranca en modo oscuro**: persiste y
expone datos vía API/permite panel, pero NO dispara ningún envío saliente
(Telegram/WhatsApp) — eso es Fase D. Los sistemas viejos (scripts, Grafana→
Telegram) no se tocan ni se apagan.

## Requirements

### Requirement: NocAlert entity and lifecycle
El sistema DEBE (MUST) persistir un `NocAlert` por combinación única
`(source, fingerprint)`, con `status` en `firing | resolved`, y campos:
`alertname`/`type`, `severity`, `entityType`/`entityName`, `message`,
`metricValue`/`metricUnit`, `threshold`, `startsAt`, `endsAt`, `link`,
`runbook`, `ackBy`, `ackAt`.

#### Scenario: Ingest a new alert creates a firing NocAlert
- GIVEN no existe ningún `NocAlert` con `(source, fingerprint)` dados
- WHEN se ingiere un payload con `status: firing` para esa combinación
- THEN se crea un `NocAlert` con `status: firing` y `startsAt` seteado

#### Scenario: Repeated firing ingest for the same fingerprint does not duplicate
- GIVEN existe un `NocAlert` `firing` con `(source, fingerprint)` dados
- WHEN se ingiere de nuevo `status: firing` para el mismo `(source, fingerprint)`
- THEN NO se crea una fila nueva — se actualiza la existente (upsert)

#### Scenario: Resolved ingest closes the matching firing NocAlert
- GIVEN existe un `NocAlert` `firing` con `(source, fingerprint)` dados
- WHEN se ingiere `status: resolved` para el mismo `(source, fingerprint)`
- THEN el `NocAlert` pasa a `status: resolved` con `endsAt` seteado

#### Scenario: Resolved ingest with no prior firing record (TODO: pendiente design.md)
- GIVEN NO existe ningún `NocAlert` previo con `(source, fingerprint)` dados
- WHEN se ingiere `status: resolved` para esa combinación
- THEN el comportamiento exacto (crear igual con `startsAt = endsAt`, o
  descartar sin crear) queda **abierto — design.md debe decidirlo**; hasta
  entonces el test de este escenario se implementa contra la decisión que
  fije el design

### Requirement: Alert ingestion endpoint auth
El sistema DEBE (MUST) exponer `POST /api/alerts/ingest/{source}` protegido
por un shared-secret configurado por fuente (molde `apiKeyMiddleware`, ver
`src/infrastructure/http/middleware/apiKeyMiddleware.ts`), fail-closed si la
key no está configurada. La ruta NO setea `req.user` (machine-to-machine).

#### Scenario: Ingest without token is rejected
- GIVEN la key de la fuente está configurada
- WHEN se hace `POST /api/alerts/ingest/{source}` sin header `X-API-Key` ni `Authorization: Bearer`
- THEN responde `401` y no se crea ningún `NocAlert`

#### Scenario: Ingest with invalid token is rejected
- GIVEN la key de la fuente está configurada
- WHEN se hace `POST /api/alerts/ingest/{source}` con una key que no coincide
- THEN responde `401` y no se crea ningún `NocAlert`

### Requirement: Acknowledge alert with MTTA
El sistema DEBE (MUST) permitir a un usuario con `monitoring.acknowledge_alert`
reconocer un `NocAlert` existente (firing o resolved), registrando `ackBy` y
`ackAt`, y calculando MTTA (`ackAt - startsAt`).

#### Scenario: Acknowledge an existing alert
- GIVEN existe un `NocAlert` sin `ackAt`
- WHEN un usuario con `monitoring.acknowledge_alert` hace ACK sobre ese id
- THEN el `NocAlert` queda `ackBy`/`ackAt` seteados y el DTO expone el MTTA calculado

#### Scenario: Acknowledge a non-existent alert returns 404
- GIVEN no existe ningún `NocAlert` con el id dado
- WHEN un usuario con `monitoring.acknowledge_alert` intenta hacer ACK sobre ese id
- THEN responde `404`

#### Scenario: Acknowledge without permission is rejected (BE-enforced)
- GIVEN un usuario autenticado SIN `monitoring.acknowledge_alert`
- WHEN intenta hacer ACK sobre un `NocAlert` existente
- THEN responde `403` — recorrido completo ruta→`requirePerm`→use-case (el use-case ni se invoca)

### Requirement: List alerts with filters and permission
El sistema DEBE (MUST) exponer `GET /api/alerts` protegido por
`monitoring.read`, soportando filtros por `source`, `severity` y `status`,
combinables.

#### Scenario: List filtered by source, severity and status
- GIVEN existen `NocAlert` de varias fuentes/severidades/estados
- WHEN un usuario con `monitoring.read` pide `GET /api/alerts?source=grafana&severity=critical&status=firing`
- THEN la respuesta contiene solo los `NocAlert` que matchean los tres filtros

#### Scenario: List without permission is rejected
- GIVEN un usuario autenticado SIN `monitoring.read`
- WHEN pide `GET /api/alerts`
- THEN responde `403`

### Requirement: DTO output only
El sistema NO DEBE (MUST NOT) devolver la entidad Prisma cruda ni la
entidad de dominio `NocAlert` sin mapear — toda ruta HTTP DEBE responder un
`NocAlertDto`.

#### Scenario: List response conforms to the DTO shape
- GIVEN existe al menos un `NocAlert` persistido
- WHEN se pide `GET /api/alerts` con permiso válido
- THEN cada elemento de la respuesta es un `NocAlertDto` (no expone campos internos de Prisma ni el objeto de dominio crudo)

### Requirement: Dark ingestion — no outbound side-effects
El sistema NO DEBE (MUST NOT) disparar ningún envío saliente
(Telegram/WhatsApp/notificación) como efecto de la ingesta o del ACK durante
esta fase — el fan-out a Telegram es Fase D.

#### Scenario: Ingesting an alert does not trigger any notification side-effect
- GIVEN el hub corre sin ningún publisher de notificaciones cableado (o con uno no-op)
- WHEN se ingiere un `NocAlert` nuevo vía `IngestAlert`
- THEN el `NocAlert` persiste correctamente y no se invoca ningún gateway de Telegram/WhatsApp

## Testing Notes

Cada escenario = 1 test. `IngestAlert`/`AcknowledgeAlert`/`ListAlerts` reales
+ `InMemoryNocAlertRepository` (NO mockear Prisma). Rutas con `supertest`
sobre la app Express real, permisos ejercitados end-to-end (seam
control→ruta→use-case→repo) — el 403 se prueba con el use-case real
inyectado, no con un stub que nunca se llama.
