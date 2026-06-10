# Spec: UISP Integration (V1)

**Capability**: `uisp-integration` (NEW)
**Change**: `uisp-integration`
**Summary**: Mirror owned de sitios y dispositivos UISP (`UispSite`/`UispDevice`) sincronizado cada 5 min por un scheduler con advisory lock y flag gate, expuesto via API de lectura desde DB (nunca live en el request path), con RBAC propio y FE de nodos.

---

## Requirements

### REQ-MIR-1: Upsert de UispSite por uispId

El sistema MUST upsert cada sitio UISP en la tabla `UispSite` usando `uispId` (UUID de UISP) como clave de identificación. Los campos almacenados son: `name`, `status`, `parentUispId`, `lat`, `lng`, `deviceCount`, `deviceOutageCount`. El campo `missingSince` MUST ser nulo en un upsert exitoso (site presente en UISP).

#### Scenario: SCEN-MIR-01 — Upsert crea nuevo site

- GIVEN que no existe `UispSite` con `uispId = "cc4fce3f-..."`
- WHEN `SyncUisp` procesa la respuesta de `/sites`
- THEN el sistema MUST crear un registro con `name`, `status`, `lat`, `lng`, `deviceCount` correctos
- AND `missingSince` MUST ser `null`

#### Scenario: SCEN-MIR-02 — Upsert actualiza site existente

- GIVEN que existe `UispSite` con `uispId = "cc4fce3f-..."` y `name = "viejo"`
- WHEN UISP devuelve ese site con `name = "nuevo"`
- THEN el sistema MUST actualizar el registro con `name = "nuevo"`
- AND `missingSince` MUST permanecer `null`

#### Scenario: SCEN-MIR-03 — Sync es idempotente

- GIVEN que el mirror ya refleja el estado actual de UISP
- WHEN `SyncUisp` corre nuevamente sin cambios en UISP
- THEN ningún registro MUST cambiar (upsert resulta en no-op efectivo)

---

### REQ-MIR-2: Upsert de UispDevice por uispId

El sistema MUST upsert cada dispositivo UISP en `UispDevice` usando su `uispId` como clave. Campos: `name`, `model`, `type`, `role`, `mac`, `ip`, `firmware`, `status`, `signal`, `uptime`, `lastSeen`, `uispSiteId` (FK a `UispSite.uispId`).

#### Scenario: SCEN-MIR-04 — Device upsertado con FK de site

- GIVEN que `UispSite` con `uispId = "site-uuid"` existe en el mirror
- WHEN UISP devuelve un device con `identification.site.id = "site-uuid"`
- THEN el device MUST ser creado/actualizado con `uispSiteId = "site-uuid"`

#### Scenario: SCEN-MIR-05 — Device que cambia de site (hook V2)

- GIVEN que `UispDevice "dev-1"` tiene `uispSiteId = "site-A"` en el mirror
- WHEN la siguiente sync trae `dev-1` con `identification.site.id = "site-B"`
- THEN el sistema MUST actualizar `uispSiteId = "site-B"` en el mirror
- AND el cambio MUST persistir sin eliminar el registro

---

### REQ-MIR-3: Soft-missing para sites y devices desaparecidos

El sistema MUST NO eliminar físicamente sites ni devices del mirror cuando desaparecen de UISP. En cambio, MUST setear `missingSince = now()`. Si reaparecen en una sync posterior, MUST limpiar `missingSince = null`.

#### Scenario: SCEN-MIR-06 — Site desaparece → missingSince seteado

- GIVEN que `UispSite "site-X"` existe en el mirror con `missingSince = null`
- WHEN `SyncUisp` corre y `/sites` no incluye `"site-X"`
- THEN `site-X.missingSince` MUST quedar seteado con la timestamp actual
- AND el registro MUST seguir existiendo en la tabla

#### Scenario: SCEN-MIR-07 — Site reaparece → missingSince limpiado

- GIVEN que `UispSite "site-X"` tiene `missingSince != null`
- WHEN la siguiente sync incluye `"site-X"` en `/sites`
- THEN `site-X.missingSince` MUST volver a `null`

#### Scenario: SCEN-MIR-08 — Device desaparece → missingSince seteado

- GIVEN que `UispDevice "dev-1"` existe con `missingSince = null`
- WHEN `SyncUisp` corre y `/devices` no incluye `"dev-1"`
- THEN `dev-1.missingSince` MUST quedar seteado

---

### REQ-SYNC-1: Scheduler con flag gate y advisory lock

`UispSyncScheduler` MUST ejecutar `SyncUisp` cada 5 minutos. Antes de cada ejecución MUST verificar el flag `uisp-sync`; si está OFF MUST omitir la corrida con log y salir. MUST adquirir un advisory lock antes de correr; si ya hay otra corrida activa MUST omitir con log (no crash).

#### Scenario: SCEN-SYNC-01 — Flag OFF → scheduler skippea

- GIVEN que el flag `uisp-sync` está `enabled = false`
- WHEN el cron del scheduler dispara
- THEN el sistema MUST loguear el skip
- AND MUST NO llamar a `SyncUisp`

#### Scenario: SCEN-SYNC-02 — Advisory lock activo → skip

- GIVEN que una corrida de sync ya está en curso (lock adquirido)
- WHEN el cron dispara nuevamente
- THEN el scheduler MUST detectar el lock y omitir la corrida con log
- AND la corrida en curso MUST continuar sin interrupción

#### Scenario: SCEN-SYNC-03 — Env ausente → skip graceful

- GIVEN que `UISP_BASE_URL` o `UISP_TOKEN` no están configurados
- WHEN el scheduler intenta correr
- THEN el sistema MUST loguear "UISP no configurado" y salir sin crash
- AND el proceso principal MUST seguir en pie (no fail-fast)

#### Scenario: SCEN-SYNC-04 — UISP caído → mirror previo intacto

- GIVEN que el flag está ON y env configurado
- WHEN UISP responde con 5xx o timeout durante la sync
- THEN la corrida MUST quedar marcada como fallida con log del error
- AND los datos previos del mirror MUST permanecer intactos (sin rollback)
- AND `lastError` MUST ser actualizado en el estado de sync

#### Scenario: SCEN-SYNC-05 — POST /api/uisp/sync → 202 encolado

- GIVEN que el usuario tiene permiso `uisp:manage`
- WHEN hace `POST /api/uisp/sync`
- THEN el sistema MUST responder `202 Accepted`
- AND MUST disparar una corrida de `SyncUisp` fuera del ciclo del cron

#### Scenario: SCEN-SYNC-06 — POST /api/uisp/sync → ya en curso

- GIVEN que ya hay una sync en curso
- WHEN el usuario hace `POST /api/uisp/sync`
- THEN el sistema MUST responder `409 Conflict` con mensaje "sync en curso"

---

### REQ-API-1: GET /api/uisp/sites sirve del mirror

El sistema MUST responder `GET /api/uisp/sites` con la lista de `UispSite` del mirror de DB. MUST NEVER hacer una llamada sincrónica a UISP durante el request. La respuesta MUST incluir `uispId`, `name`, `status`, `deviceCount`, `deviceOutageCount`, `lastSyncAt`.

#### Scenario: SCEN-API-01 — Lista de sites desde mirror

- GIVEN que el mirror tiene 73 `UispSite` y el usuario tiene `uisp:read`
- WHEN hace `GET /api/uisp/sites`
- THEN el sistema MUST responder 200 con array de sites del mirror
- AND la respuesta MUST NO requerir llamada al API de UISP

#### Scenario: SCEN-API-02 — Site con status "unknown" se sirve tal cual

- GIVEN que `UispSite "site-X"` tiene `status = "unknown"`
- WHEN el usuario consulta la lista
- THEN el sistema MUST incluir `"status": "unknown"` en la respuesta
- AND MUST NO tratar ese valor como error ni warning

#### Scenario: SCEN-API-03 — 403 sin permiso uisp:read

- GIVEN que el usuario autenticado NO tiene permiso `uisp:read`
- WHEN hace `GET /api/uisp/sites`
- THEN el sistema MUST responder `403 Forbidden`

---

### REQ-API-2: GET /api/uisp/sites/:uispId — detalle + devices

El sistema MUST responder con los datos del `UispSite` identificado por `uispId`, incluyendo la lista de `UispDevice` asociados (desde el mirror). Requiere permiso `uisp:read`.

#### Scenario: SCEN-API-04 — Detalle de site existente con devices

- GIVEN que `UispSite "site-X"` tiene 11 `UispDevice` en el mirror
- WHEN el usuario hace `GET /api/uisp/sites/site-X`
- THEN el sistema MUST responder 200 con datos del site + array de devices
- AND cada device MUST incluir `name`, `model`, `type`, `role`, `status`, `signal`, `uptime`, `ip`

#### Scenario: SCEN-API-05 — 404 site inexistente

- GIVEN que no existe `UispSite` con `uispId = "no-existe"`
- WHEN el usuario hace `GET /api/uisp/sites/no-existe`
- THEN el sistema MUST responder `404 Not Found`

---

### REQ-API-3: GET /api/uisp/sync/status — estado del sync

El sistema MUST exponer `GET /api/uisp/sync/status` con `lastSyncAt`, `siteCount`, `deviceCount`, `inFlight` y `lastError`. Requiere `uisp:read`.

#### Scenario: SCEN-API-06 — Status con sync nunca corrida

- GIVEN que `SyncUisp` nunca fue ejecutado
- WHEN el usuario consulta `GET /api/uisp/sync/status`
- THEN el sistema MUST responder 200 con `lastSyncAt: null`, `siteCount: 0`, `deviceCount: 0`

---

### REQ-SEC-1: Módulo `uisp` + permisos `read`/`manage` en migración

El sistema MUST crear el módulo RBAC `uisp` con las acciones `read` y `manage` sembradas via migración idempotente. MUST otorgar ambas al rol `super_admin`. MUST agregar `uisp:read` y `uisp:manage` a `KNOWN_ACTIONS` en `src/domain/entities/rbac.ts`.

#### Scenario: SCEN-SEC-01 — super_admin tiene uisp:read y uisp:manage

- GIVEN que la migración de RBAC fue aplicada
- WHEN se consultan los permisos efectivos de un usuario con rol `super_admin`
- THEN MUST incluir `uisp:read` y `uisp:manage`

#### Scenario: SCEN-SEC-02 — Flag uisp-sync sembrado OFF

- GIVEN que la migración fue aplicada
- WHEN se lee el flag `uisp-sync` de la tabla `FeatureFlag`
- THEN su valor MUST ser `enabled = false`
- AND la fila MUST existir exactamente una vez (idempotente via ON CONFLICT DO NOTHING)

---

### REQ-FE-1: Página Nodos (lista de sites)

El FE MUST mostrar una página `/nodos` gateada por `uisp.read`. La tabla MUST listar sites con: `name`, `status` (badge), `deviceCount`, `deviceOutageCount` (caídas), `lastSyncAt`. Cuando el mirror está vacío (sync nunca corrió o no configurado), MUST mostrar un empty state descriptivo.

#### Scenario: SCEN-FE-01 — Lista de 73 nodos visible

- GIVEN que el usuario tiene `uisp:read` y el mirror tiene 73 sites
- WHEN navega a `/nodos`
- THEN la tabla MUST mostrar los 73 sites con nombre, status, deviceCount, caídas y fecha de sync

#### Scenario: SCEN-FE-02 — Empty state cuando sync nunca corrió

- GIVEN que `GET /api/uisp/sync/status` devuelve `lastSyncAt: null`
- WHEN el usuario con `uisp:read` navega a `/nodos`
- THEN MUST mostrar empty state con mensaje "La sincronización nunca fue ejecutada"

#### Scenario: SCEN-FE-03 — Empty state cuando no configurado

- GIVEN que `UISP_BASE_URL`/`UISP_TOKEN` no están configurados
- WHEN el usuario con `uisp:read` navega a `/nodos`
- THEN MUST mostrar empty state con mensaje "UISP no configurado"

---

### REQ-FE-2: Página detalle del nodo

El FE MUST mostrar una página de detalle por site con: datos generales (name, status, lat/lng, parent) + tabla de devices con columnas `status` (badge), `signal` (dBm), `uptime`, `ip`. Los devices con `missingSince != null` MUST mostrar badge "missing". Requiere `uisp:read`.

#### Scenario: SCEN-FE-04 — Detalle de nodo con devices

- GIVEN que `UispSite "site-X"` tiene 11 devices en el mirror
- WHEN el usuario navega al detalle del nodo
- THEN MUST ver los datos generales del site + tabla con los 11 devices
- AND cada device MUST mostrar status, signal, uptime, ip

#### Scenario: SCEN-FE-05 — Badge "missing" en device con missingSince

- GIVEN que `UispDevice "dev-1"` tiene `missingSince != null`
- WHEN el usuario ve la tabla de devices del nodo
- THEN `dev-1` MUST mostrar badge "missing" distintivo

---

### REQ-FE-3: Sidebar entry y botones de gestión

El FE MUST agregar entrada "Nodos" en el sidebar bajo la sección "Red", visible solo con `uisp:read`. Los controles "Sincronizar ahora" y el toggle del flag `uisp-sync` MUST estar gateados por `uisp:manage`. La sección de config MUST mostrar "no configurado" cuando faltan las env vars.

#### Scenario: SCEN-FE-06 — Sidebar visible con uisp:read, oculto sin él

- GIVEN que el usuario A tiene `uisp:read` y el usuario B no
- WHEN ambos ven el sidebar
- THEN solo el usuario A MUST ver la entrada "Nodos"

#### Scenario: SCEN-FE-07 — "Sincronizar ahora" gateado por uisp:manage

- GIVEN que el usuario tiene `uisp:read` pero NO `uisp:manage`
- WHEN ve la página de nodos
- THEN el botón "Sincronizar ahora" MUST estar oculto o deshabilitado

---

## Appendix: Campos del Mirror

| Entidad | Campo | Fuente UISP |
|---------|-------|-------------|
| `UispSite` | `uispId` | `identification.id` |
| `UispSite` | `name` | `identification.name` |
| `UispSite` | `status` | `identification.status` |
| `UispSite` | `parentUispId` | `identification.parent.id` |
| `UispSite` | `lat` / `lng` | `description.location.latitude/longitude` |
| `UispSite` | `deviceCount` | `description.deviceCount` |
| `UispSite` | `deviceOutageCount` | `description.deviceOutageCount` |
| `UispDevice` | `uispId` | `identification.id` |
| `UispDevice` | `name` | `identification.name` |
| `UispDevice` | `model` | `identification.model` |
| `UispDevice` | `type` | `identification.type` |
| `UispDevice` | `role` | `identification.role` |
| `UispDevice` | `mac` | `identification.mac` |
| `UispDevice` | `ip` | `ipAddress` (top-level) |
| `UispDevice` | `firmware` | `identification.firmwareVersion` |
| `UispDevice` | `status` | `overview.status` |
| `UispDevice` | `signal` | `overview.signal` |
| `UispDevice` | `uptime` | `overview.uptime` |
| `UispDevice` | `lastSeen` | `overview.lastSeen` |
| `UispDevice` | `uispSiteId` | `identification.site.id` |

## Appendix: Error Codes HTTP

| Dominio | HTTP | Código |
|---------|------|--------|
| `UispUnavailableError` | 502 | `UISP_UNAVAILABLE` |
| Site no encontrado | 404 | `UISP_SITE_NOT_FOUND` |
| Sin permiso | 403 | `FORBIDDEN` |
| Sync ya en curso | 409 | `SYNC_IN_FLIGHT` |
