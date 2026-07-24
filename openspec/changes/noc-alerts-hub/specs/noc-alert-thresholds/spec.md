# Noc Alert Thresholds Specification

## Purpose

Config singleton de umbrales de fibra (`NocAlertThresholdsConfig`, molde
`GestionRealIngestConfig`/`NocBroadcastConfig` — `id: "singleton"`, editable en
runtime), lado HUB (BE) únicamente. Dos consumidores con auth distinta: (a) el panel
FE (humano, cookie de sesión + `monitoring.manage`) puede LEER y EDITAR; (b) el
colector Rust (máquina, `apiKeyMiddleware` con `fiberIngestKey`) SOLO puede LEER —
nunca edita umbrales, los recibe. Defaults sembrados = los valores hoy vigentes en
`/etc/fibra_report.conf` de la VM 130: `CRIT_DBM=-30`, `WARN_DBM=-27`,
`DELTA_ALERT=2.0`, `PON_MIN_ABON=2`, `PON_DELTA=1.5`. **Fuera de alcance de este
spec**: sincronizar un umbral editado en el panel con las reglas de Grafana vía su API
— eso es Fase F+ (posterior, más cara, requiere decisión explícita del usuario sobre
si "editar" implica push real a Grafana o es solo visualización/config del lado
fibra). Editar acá NO toca ninguna regla de Grafana ni ningún archivo de la VM 130.

## Requirements

### Requirement: Threshold singleton with seeded defaults
El sistema DEBE (MUST) persistir un único `NocAlertThresholdsConfig`
(`id: "singleton"`) con los campos `CRIT_DBM`, `WARN_DBM`, `DELTA_ALERT`,
`PON_MIN_ABON`, `PON_DELTA`, sembrado con los defaults de `/etc/fibra_report.conf`
(`-30`, `-27`, `2.0`, `2`, `1.5`) vía migración idempotente (`ON CONFLICT DO NOTHING`).

#### Scenario: Reading thresholds before any edit returns the seeded defaults
- GIVEN nunca se editó `NocAlertThresholdsConfig` desde que se sembró
- WHEN se consulta el singleton
- THEN los valores son `CRIT_DBM=-30`, `WARN_DBM=-27`, `DELTA_ALERT=2.0`, `PON_MIN_ABON=2`, `PON_DELTA=1.5`

### Requirement: Human read access requires monitoring.manage
El sistema DEBE (MUST) exponer `GET /api/alerts/thresholds` para usuarios humanos
(cookie de sesión) protegido por `requirePerm('monitoring.manage')`.

#### Scenario: User with monitoring.manage reads current thresholds
- GIVEN un usuario autenticado con `monitoring.manage`
- WHEN hace `GET /api/alerts/thresholds`
- THEN responde `200` con los valores vigentes del singleton

#### Scenario: User without monitoring.manage is rejected
- GIVEN un usuario autenticado SIN `monitoring.manage`
- WHEN hace `GET /api/alerts/thresholds`
- THEN responde `403`

### Requirement: Machine read access via fiberIngestKey, read-only
El sistema DEBE (MUST) permitir además que el colector Rust lea el mismo endpoint
autenticado con `apiKeyMiddleware(fiberIngestKey)` (sin sesión ni RBAC de usuario), y
NO DEBE (MUST NOT) permitirle editar por esa misma vía.

#### Scenario: Fiber collector reads thresholds with its API key
- GIVEN el colector se autentica con `fiberIngestKey` válida (header `X-API-Key` o `Authorization: Bearer`)
- WHEN hace `GET /api/alerts/thresholds`
- THEN responde `200` con los mismos valores vigentes que ve el panel

#### Scenario: Missing or invalid API key without session is rejected
- GIVEN la request no trae cookie de sesión válida NI una `fiberIngestKey` válida
- WHEN hace `GET /api/alerts/thresholds`
- THEN responde `401`

#### Scenario: Fiber collector cannot edit thresholds via its API key
- GIVEN el colector se autentica con `fiberIngestKey` válida (sin sesión de usuario)
- WHEN intenta `PUT /api/alerts/thresholds`
- THEN responde `401`/`403` (rechazado — la vía machine es solo lectura) y el singleton NO cambia

### Requirement: Human edit requires monitoring.manage
El sistema DEBE (MUST) exponer `PUT /api/alerts/thresholds` para usuarios humanos
(cookie de sesión) protegido por `requirePerm('monitoring.manage')`, actualizando el
singleton completo.

#### Scenario: User with monitoring.manage updates thresholds
- GIVEN un usuario autenticado con `monitoring.manage`
- WHEN hace `PUT /api/alerts/thresholds` con nuevos valores válidos para los 5 campos
- THEN el singleton queda actualizado y un `GET` posterior refleja los nuevos valores

#### Scenario: User without monitoring.manage cannot edit
- GIVEN un usuario autenticado SIN `monitoring.manage`
- WHEN hace `PUT /api/alerts/thresholds`
- THEN responde `403` y el singleton NO cambia

### Requirement: Update validates required numeric fields
El sistema DEBE (MUST) rechazar con `400` un `PUT` que omita alguno de los 5 campos o
que envíe un valor no numérico, sin aplicar una actualización parcial.

#### Scenario: Invalid or incomplete payload is rejected without a partial update
- GIVEN un usuario con `monitoring.manage` y el singleton tiene valores actuales conocidos
- WHEN hace `PUT /api/alerts/thresholds` con un campo faltante o un valor no numérico
- THEN responde `400` y el singleton mantiene exactamente los valores previos (ningún campo se actualiza parcialmente)

## Testing Notes

Molde exacto de `GestionRealIngestConfig`/`NocBroadcastConfig`: port
`NocAlertThresholdsConfigRepository` (`get`/`update`) +
`PrismaNocAlertThresholdsConfigRepository`/`InMemoryNocAlertThresholdsConfigRepository`
+ use-cases `GetAlertThresholds`/`UpdateAlertThresholds`. NUNCA mockear Prisma en los
tests de use-case — usar el in-memory. La ruta soporta DOS mecanismos de auth
(`createAuthMiddleware`+`requirePerm` para humanos, `apiKeyMiddleware` para el
colector) — testear ambos caminos por separado con `supertest`, y el caso "ninguno de
los dos" (401). El escenario de sync con Grafana NO se testea acá — está
explícitamente fuera de alcance (Fase F+, nota en Purpose).
