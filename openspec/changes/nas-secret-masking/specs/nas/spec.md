# Capability: nas

Gestión de NAS servers (RADIUS/RouterOS/orchestrator) — inventario, config RADIUS y su
exposición vía la API HTTP `/api/nas-servers` + `/api/radius-config`.

## MODIFIED Requirements

### Requirement: Enmascarado de secretos en TODAS las respuestas de NAS

El sistema SHALL enmascarar `radiusSecret` y `apiPassword` de un `NasServer` en TODA respuesta
de la API de NAS servers — lectura (`ListNasServers`, `GetNasServer` → `GET /api/nas-servers` /
`GET /api/nas-servers/:id`) Y escritura (`CreateNasServer`, `UpdateNasServer` →
`POST /api/nas-servers` / `PUT /api/nas-servers/:id`) — reemplazando cualquier valor no-vacío
por la máscara fija `NAS_SECRET_MASK` ("••••••••"). Un valor `null` o `''` SHALL preservarse tal
cual (no se enmascara un campo que ya está vacío). El enmascarado SHALL aplicarse en la capa de
use case sobre la entidad que se DEVUELVE, NUNCA en el repositorio ni sobre lo que se PERSISTE
(el repo guarda el secreto real y es compartido con el flujo PPPoE/enforcement, que lo necesita).
Ninguna puerta de la API SHALL filtrar el secreto real en su respuesta.

#### Scenario: list con secreto real almacenado
- **WHEN** se llama `GET /api/nas-servers` y un NAS tiene `radiusSecret`/`apiPassword` reales
  (no vacíos) almacenados
- **THEN** la respuesta trae `radiusSecret = '••••••••'` y `apiPassword = '••••••••'` para ese
  NAS, y el JSON completo de la respuesta NO contiene el valor real en ningún lado

#### Scenario: get por id con secreto real almacenado
- **WHEN** se llama `GET /api/nas-servers/:id` sobre un NAS con secretos reales
- **THEN** la respuesta enmascara ambos campos igual que en el list

#### Scenario: create enmascara su respuesta pero persiste el real
- **WHEN** se llama `POST /api/nas-servers` con `radiusSecret`/`apiPassword` reales
- **THEN** la respuesta (201) trae ambos campos enmascarados y su JSON NO contiene el valor real,
  PERO el NAS queda almacenado con el secreto REAL (recuperable por el flujo de enforcement)

#### Scenario: update enmascara su respuesta pero persiste el nuevo real
- **WHEN** se llama `PUT /api/nas-servers/:id` con un `radiusSecret` nuevo real
- **THEN** la respuesta (200) trae el campo enmascarado y su JSON NO contiene el valor real,
  PERO el NAS queda almacenado con el nuevo secreto REAL

#### Scenario: NAS con apiPassword null (ej. Ubiquiti sin API)
- **WHEN** un NAS tiene `apiPassword = null` (no aplica API, ej. tipo `ubiquiti`)
- **THEN** la respuesta preserva `apiPassword = null` (no se enmascara un valor ya vacío)

#### Scenario: enmascarado sobrevive al enriquecido con live-stats
- **WHEN** un NAS es `radius_orchestrator` y su respuesta se enriquece con `clientCount`/`lastSeen`
  en vivo vía `NasLiveStatsProvider`
- **THEN** el resultado enriquecido TAMBIÉN llega enmascarado (el enmascarado se aplica después
  del enriquecido, sobre el DTO final)

### Requirement: Sentinel de write-path contra el pisado del secreto

`UpdateNasServer` SHALL descartar del patch enviado al repositorio cualquier `radiusSecret` o
`apiPassword` que sea `undefined`, `''` (string vacío) o exactamente igual a `NAS_SECRET_MASK`,
de forma que un PUT que reenvía la máscara mostrada en un formulario (o un campo vacío) NUNCA
sobrescriba el secreto real ya almacenado. Un valor realmente nuevo (distinto de la máscara y
no vacío) SHALL actualizar el campo normalmente. Un `apiPassword = null` explícito SHALL pasar
intacto (permite limpiar el campo deliberadamente).

#### Scenario: PUT reenviando la máscara no pisa el secreto
- **WHEN** se hace `PUT /api/nas-servers/:id` con `{ radiusSecret: '••••••••' }`
- **THEN** el secreto almacenado permanece sin cambios

#### Scenario: PUT con campo vacío no pisa el secreto
- **WHEN** se hace `PUT /api/nas-servers/:id` con `{ radiusSecret: '' }`
- **THEN** el secreto almacenado permanece sin cambios

#### Scenario: PUT con un secreto nuevo real sí actualiza
- **WHEN** se hace `PUT /api/nas-servers/:id` con `{ radiusSecret: 'NEW-REAL' }` (valor distinto
  de la máscara y no vacío)
- **THEN** el secreto almacenado se actualiza a `'NEW-REAL'`

#### Scenario: PUT con apiPassword null limpia el campo
- **WHEN** se hace `PUT /api/nas-servers/:id` con `{ apiPassword: null }`
- **THEN** el campo se actualiza a `null` (el sentinel no bloquea un `null` explícito)
