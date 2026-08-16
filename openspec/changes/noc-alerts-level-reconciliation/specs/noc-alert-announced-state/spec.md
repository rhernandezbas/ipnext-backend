# NOC Alert Announced State Specification

## Purpose

Expone al colector de fibra —y a cualquier fuente de ingesta futura— el estado
ANUNCIADO que el hub tiene actualmente `firing` para ESA fuente, para que el
emisor pueda reconciliar por nivel en vez de recordar flancos. El hub es la
ÚNICA fuente de verdad de "qué está abierto"; ningún colector persiste un espejo.

Auth de máquina con la MISMA key de ingesta de la fuente (molde ya existente:
`createThresholdsReadAuth` sobre `GET /api/alerts/thresholds`). Endpoint
READ-ONLY: la key nunca puede mutar nada por esta ruta.

## Requirements

### Requirement: Machine read access scoped por fuente

El sistema DEBE (MUST) exponer `GET /api/alerts/ingest/:source/state`,
autenticado con la key de ingesta de ESE `:source` (`ingestKeys[source]`, la
misma que guarda `POST /api/alerts/ingest/:source`). Una fuente desconocida DEBE
responder 404 ANTES de comparar key alguna. Una key ausente, vacía o inválida
DEBE responder 401 (fail-closed).

#### Scenario: La ingest key de la fuente autoriza la lectura
- GIVEN `fiberIngestKey` configurada para la fuente `fiber-collector`
- WHEN se hace `GET /api/alerts/ingest/fiber-collector/state` con `Authorization: Bearer <fiberIngestKey>`
- THEN responde 200 con el estado anunciado de esa fuente

#### Scenario: La key de otra fuente no sirve
- GIVEN `grafanaIngestKey` distinta de `fiberIngestKey`
- WHEN se hace `GET /api/alerts/ingest/fiber-collector/state` con la `grafanaIngestKey`
- THEN responde 401

#### Scenario: Fuente desconocida responde 404
- WHEN se hace `GET /api/alerts/ingest/inventada/state` con cualquier key
- THEN responde 404 con código `UNKNOWN_INGEST_SOURCE`

#### Scenario: Sin credenciales responde 401
- WHEN se hace `GET /api/alerts/ingest/fiber-collector/state` sin header de auth
- THEN responde 401

#### Scenario: Key configurada como vacía falla cerrado
- GIVEN la key de la fuente `fiber-collector` está configurada como cadena vacía
- WHEN se hace el GET con cualquier valor de key
- THEN responde 401

### Requirement: Proyección mínima, solo firing, sin envelope

La respuesta DEBE (MUST) ser un ARRAY PLANO (sin envelope `{data}`), conteniendo
únicamente las alertas de esa fuente con `status: "firing"`, proyectadas a
`{fingerprint, severity, startsAt, acknowledged}`. NO DEBE (MUST NOT) incluir
`message`, `entity`, `explanation` ni ningún campo no necesario para reconciliar.

#### Scenario: Solo se devuelven las firing
- GIVEN la fuente `fiber-collector` tiene 3 alertas `firing` y 40 `resolved`
- WHEN se pide el estado
- THEN el array tiene exactamente 3 elementos

#### Scenario: Alertas de otras fuentes quedan fuera
- GIVEN existen alertas `firing` de la fuente `grafana`
- WHEN se pide el estado de `fiber-collector`
- THEN ninguna alerta de `grafana` aparece en la respuesta

#### Scenario: El body es un array, no un objeto
- WHEN se pide el estado con una key válida
- THEN el body deserializa como array JSON en la raíz
- AND NO tiene una propiedad `data`

#### Scenario: Un estado anunciado vacío devuelve un array vacío
- GIVEN la fuente no tiene ninguna alerta `firing`
- WHEN se pide el estado
- THEN responde 200 con `[]`

#### Scenario: El ACK del operador viaja en la proyección
- GIVEN una alerta `firing` de esa fuente fue ackeada desde el panel
- WHEN se pide el estado
- THEN su elemento trae `acknowledged: true`

### Requirement: Ruta de solo lectura

Esta ruta NO DEBE (MUST NOT) aceptar métodos de escritura ni permitir que la key
de máquina modifique estado alguno. El kill-switch `noc-alerts-hub-enabled` DEBE
(MUST) aplicarse igual que en `POST /ingest/:source`.

#### Scenario: Con el hub deshabilitado responde 503
- GIVEN el feature flag `noc-alerts-hub-enabled` está en `false`
- WHEN se pide el estado con una key válida
- THEN responde 503 con código `NOC_ALERTS_HUB_DISABLED`

#### Scenario: La sesión humana también puede leerlo
- GIVEN un usuario con sesión y permiso `monitoring.read`
- WHEN pide el estado sin key de máquina
- THEN responde 200 (mismo molde dual-auth que `GET /thresholds`)
