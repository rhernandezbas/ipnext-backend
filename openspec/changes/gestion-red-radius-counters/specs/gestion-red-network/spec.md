# Capability: gestion-red-network

Contadores de la página Gestión de Red. Para NAS sobre RADIUS, la verdad técnica vive en el RADIUS (vía el radius-orchestrator), no en tablas STORED de Prominense. Esta capability cubre los contadores PROPIOS del NAS (`clientCount`, `lastSeen`) y el TIPO de display. (Los contadores de pools/redes y la tab Asignaciones ya se computan en vivo — fuera de este delta.)

## ADDED Requirements

### Requirement: clientCount en vivo para NAS RADIUS

El sistema SHALL computar `clientCount` de un NAS `type='mikrotik_radius'` desde las SESIONES ACTIVAS del RADIUS (vía `RadiusOrchestratorGateway.listActiveSessions` → orchestrator `GET /sessions`, que expone `radacct WHERE acctstoptime IS NULL`) al momento de listar/obtener el NAS, en lugar de devolver el campo STORED `NasServer.clientCount`. La atribución sesión → NAS SHALL ser por `framedIp` ∈ rangos de los pools del NAS (`findPoolsByNas`), contando sesiones distintas.

#### Scenario: NAS RADIUS reporta clientes reales
- **WHEN** se lista un NAS con `type='mikrotik_radius'` que tiene N sesiones activas cuyo Framed-IP cae en sus pools, y `clientCount` STORED = 0
- **THEN** el NAS devuelto trae `clientCount = N` (sesiones activas atribuidas, no el `0` stored)

#### Scenario: NAS RADIUS sin sesiones atribuidas reporta 0 real
- **WHEN** el orchestrator responde OK pero ninguna sesión activa cae en los pools del NAS `mikrotik_radius`
- **THEN** el NAS devuelto trae `clientCount = 0` REAL (no se cae al stored: el fallback al stored solo aplica si la fuente NO respondió)

#### Scenario: NAS legacy conserva el valor stored
- **WHEN** se lista un NAS con `type != 'mikrotik_radius'` (p. ej. `mikrotik_api`)
- **THEN** el NAS devuelto trae el `clientCount` STORED sin tocar, y NO se consulta al orchestrator

### Requirement: lastSeen en vivo para NAS RADIUS (best-effort)

El sistema SHALL reflejar en `lastSeen` la actividad reciente del NAS `type='mikrotik_radius'` derivada de `max(startedAt)` de sus sesiones activas atribuidas; si no hay sesiones atribuidas, SHALL conservar el `lastSeen` STORED.

#### Scenario: actividad reciente disponible
- **WHEN** un NAS `mikrotik_radius` tiene sesiones activas atribuidas reportadas por el RADIUS
- **THEN** `lastSeen` refleja `max(startedAt)` de esas sesiones (no `null` stored)

#### Scenario: sin dato de actividad → fallback stored
- **WHEN** la fuente RADIUS no expone actividad para el NAS
- **THEN** `lastSeen` conserva el valor STORED (no se inventa un instante)

### Requirement: degradación best-effort si el orchestrator no responde

El sistema SHALL devolver el listado/detalle de NAS aunque el orchestrator esté caído: el NAS RADIUS sale con sus valores STORED y el endpoint NO falla.

#### Scenario: orchestrator caído no rompe el listado
- **WHEN** se lista NAS y el orchestrator es inalcanzable (timeout / 5xx)
- **THEN** el endpoint responde 200 con los NAS, el NAS RADIUS sale con `clientCount`/`lastSeen` STORED, y NO se propaga un 500

#### Scenario: una sola llamada al orchestrator por request
- **WHEN** se listan varios NAS `mikrotik_radius` en la misma request
- **THEN** el orchestrator se consulta una sola vez (dato global cacheado por request), no una vez por NAS

### Requirement: TIPO de display honesto sin alterar el ruteo

El sistema SHALL exponer un campo de display (`displayType`) derivado de `nas.type`, SIN modificar `nas.type` (que sigue gobernando el ruteo de la fuente de datos).

#### Scenario: NAS RADIUS muestra label neutro
- **WHEN** se serializa un NAS con `type='mikrotik_radius'`
- **THEN** `displayType = "BRAS RADIUS"` y `type` sigue siendo `"mikrotik_radius"` (ruteo intacto)

#### Scenario: NAS no-RADIUS mantiene su label
- **WHEN** se serializa un NAS con `type='mikrotik_api'`
- **THEN** `displayType` es el label correspondiente al type (p. ej. "MikroTik API") y el contrato existente del DTO no rompe

### Requirement: el dato real cruza el seam route → use case → gateway

El sistema SHALL garantizar que los contadores en vivo lleguen al JSON de respuesta atravesando la ruta HTTP real, el use case real y el gateway, sin mockear el use case.

#### Scenario: GET /api/nas-servers entrega números reales
- **WHEN** se hace `GET /api/nas-servers` con un NAS `mikrotik_radius` con clientes activos en el gateway in-memory
- **THEN** la respuesta JSON trae `clientCount` real y `displayType="BRAS RADIUS"` para ese NAS

#### Scenario: GET /api/nas-servers/:id entrega números reales
- **WHEN** se hace `GET /api/nas-servers/:id` de un NAS `mikrotik_radius`
- **THEN** la respuesta JSON trae el `clientCount`/`lastSeen` en vivo (o fallback stored) y `displayType`

### Requirement: el orchestrator expone sesiones activas globales (cross-repo)

El `freeradius-orchestrator` SHALL exponer `GET /sessions?offset=&limit=` (gateado con `require_token`) que devuelve la lista de sesiones activas globales (`radacct WHERE acctstoptime IS NULL`) como `list[SessionResponse]`, cableando la query `list_active_paginated` ya existente vía un nuevo método del inbound port `SessionControlPort` y el service.

#### Scenario: GET /sessions devuelve sesiones activas paginadas
- **WHEN** se hace `GET /sessions?offset=0&limit=1000` con token válido
- **THEN** responde 200 con `list[SessionResponse]` (`session_id, username, nas_ip, framed_ip, started_at, bytes_in, bytes_out, caller_id`) de las sesiones radacct abiertas

#### Scenario: GET /sessions exige token
- **WHEN** se hace `GET /sessions` sin `Authorization: Bearer`
- **THEN** responde 401 (igual que el resto de las rutas del orchestrator)
