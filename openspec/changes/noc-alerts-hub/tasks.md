# Tasks: NOC Alerts Hub

> Strict TDD (RED→GREEN→REFACTOR). Fases A-D + lado-hub de E (contrato ingesta fibra +
> umbrales) descompuestas. Fase E (código del colector Rust en sí, repo aparte) la
> maneja otro agente en `ipnext-noc-collector` — acá solo el contrato que el HUB debe
> aceptar. Fase F+ (sync Grafana) queda fuera, solo nota.
> Adapter fake = `InMemoryNocAlertRepository` (NUNCA mockear Prisma). Dark: flags OFF/ON per design.

## Fase A — Fundación (`noc-alert-hub`)

### Domain
- [ ] A1 `src/domain/entities/nocAlert.ts`: entidad `NocAlert` + `NocAlertInput` + `NocAlertNotFoundError`.
- [ ] A2 `src/domain/ports/{NocAlertRepository,AlertSource,AlertEventPublisher,AlertNotifier}.ts`: interfaces por design.md §Puertos.

### Test doubles (soporte, no red/green)
- [ ] A3 `src/infrastructure/adapters/in-memory/InMemoryNocAlertRepository.ts` implementando `NocAlertRepository`.
- [ ] A4 Fakes no-op de `AlertEventPublisher`/`AlertNotifier` para tests de "dark ingestion".

### IngestAlert (dedup + ciclo de vida)
- [ ] A5 RED: 3 tests — nueva firing crea; firing repetido no duplica (upsert); resolved cierra la firing existente.
- [ ] A6 **Decisión abierta del spec**: resolved sin firing previo → default = **crear igual la fila** (`startsAt = endsAt`, `status: resolved`) + log warning (no descartar silencioso, evita perder señal de Grafana late-webhook). RED test contra este default.
- [ ] A7 GREEN: `IngestAlert.ts` (upsert por `(source, fingerprint)`).
- [ ] A8 REFACTOR `IngestAlert`.
- [ ] A9 RED+GREEN: dark ingestion — con publisher/notifier no-op, ingesta persiste y NO se invoca notify.

### AcknowledgeAlert
- [ ] A10 RED: ack existente setea `ackBy`/`ackAt`; ack de id inexistente no lanza (use-case retorna null, ruta mapea 404).
- [ ] A11 GREEN: `AcknowledgeAlert.ts` + cálculo MTTA (`ackAt-startsAt`).

### ListAlerts + DTO
- [ ] A12 RED: filtro combinado `source+severity+status`.
- [ ] A13 GREEN: `ListAlerts.ts`.
- [ ] A14 `src/application/dto/nocAlert.ts`: `NocAlertDto` (+ MTTA) — RED test: shape no expone entidad/Prisma crudo.

### Infra: persistencia + flags
- [ ] A15 `prisma/schema.prisma`: modelo `NocAlert` (`@@unique([source, fingerprint])`) + comentario de coexistencia con `MonitoringAlert`/`Notification`.
- [ ] A16 Migración aditiva `prisma/migrations/*_noc_alert/`: crea tabla + seed `FeatureFlag` (`noc-alerts-hub-enabled` ON, `noc-alerts-telegram-send` OFF, `ON CONFLICT DO NOTHING`).
- [ ] A17 `src/infrastructure/adapters/prisma/PrismaNocAlertRepository.ts` (mapea row→entidad, nunca crudo).

### Infra: rutas + auth
- [ ] A18 Modificar `apiKeyMiddleware.ts`: parametrizar `createApiKeyMiddleware(configuredKey: string)` (factory, no hardcodea `config.externalApi.apiKey`) — RED test unit del middleware con key inyectada.
- [ ] A19 RED (supertest): `POST /api/alerts/ingest` sin key → 401 sin crear; con key inválida → 401 sin crear.
- [ ] A20 RED (supertest): `GET /api/alerts` sin `monitoring.read` → 403; con permiso → lista filtrada DTO.
- [ ] A21 RED (supertest): `POST /:id/acknowledge` sin `monitoring.acknowledge_alert` → 403 (use-case no invocado); con permiso → 200; id inexistente → 404. (`monitoring.acknowledge_alert` ya existe en `rbac.ts:41`, no requiere seed nuevo.)
- [ ] A22 GREEN: `src/infrastructure/http/routes/alerts.routes.ts` (`/ingest`, `GET /`, `POST /:id/acknowledge`) con `apiKeyMiddleware`/`createAuthMiddleware`+`requirePerm` por ruta.
- [ ] A23 `config.ts`: fail-fast `fiberIngestKey`/`grafanaIngestKey` al import.
- [ ] A24 `app.ts`: `composeAlertsModule()` (evita inflar God Object) que monta `/api/alerts`; RED+GREEN test de composition-root (assert wiring de ports/repo correctos, molde lección W6).

## Fase B — Grafana source (`noc-alert-grafana-source`)

- [ ] B1 RED: `GrafanaWebhookSource.map` — labels/annotations → `alertname`/`entityType`/`entityName`/`message`/`runbook`/`link`/`fingerprint`.
- [ ] B2 GREEN: `src/infrastructure/adapters/grafana/GrafanaWebhookSource.ts` implementando `AlertSource`.
- [ ] B3 RED: payload sin `alerts` o elemento sin `fingerprint`/`status` → 400, sin crear/actualizar nada.
- [ ] B4 RED: webhook con 2 elementos (`fingerprint` distintos) → 2 `NocAlert` creados.
- [ ] B5 RED (supertest): `POST /api/alerts/ingest/grafana` firing crea `NocAlert` `source: grafana`; resolved cierra el match.
- [ ] B6 GREEN: montar `/ingest/grafana` en `alerts.routes.ts` con `apiKeyMiddleware(grafanaIngestKey)` + `GrafanaWebhookSource` + validación→400, delegando al mismo `IngestAlert` (A7).
- [ ] B7 Reusar auth 401 de A19 (no reespecificar) — solo test de malformed/mapeo son nuevos acá.
- [ ] B8 Actualizar composition-root test (A24) para incluir wiring de `GrafanaWebhookSource`.

## Fase C — Panel + SSE (`noc-alert-realtime`)

### Infra: event bus + wiring de publish
- [ ] C1 `src/infrastructure/events/AlertEventBus.ts`: wrapper de `EventEmitter` implementando `AlertEventPublisher` (port de A2).
- [ ] C2 Spy de `AlertEventPublisher` (extiende el fake no-op de A4) para assertear llamadas de publish sin depender del bus real.
- [ ] C3 RED: `IngestAlert` con publisher real cableado — publica `{type:'firing', alert}` DESPUÉS de persistir OK.
- [ ] C4 RED: `AcknowledgeAlert` con publisher real cableado — publica `{type:'acked', alert}` DESPUÉS de persistir OK.
- [ ] C5 GREEN: cablear `AlertEventBus` en `composeAlertsModule()` (A24) como implementación del port.

### Ruta SSE
- [ ] C6 RED (supertest/raw request): `GET /api/alerts/stream` sin cookie de sesión → `401`, stream no se abre.
- [ ] C7 RED: `GET /api/alerts/stream` con sesión pero sin `monitoring.read` → `403`.
- [ ] C8 RED: con permiso → headers correctos (`text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`) + `res.flushHeaders()` inmediato.
- [ ] C9 GREEN: `src/infrastructure/http/routes/alerts.routes.ts` monta `/stream` con `createAuthMiddleware`+`requirePerm('monitoring.read')`, se suscribe al bus.
- [ ] C10 RED: evento publicado al bus mientras un cliente está conectado → el cliente recibe un frame `data:` con el `NocAlertDto`.
- [ ] C11 GREEN: handler SSE mapea eventos del bus → `res.write` de frames.
- [ ] C12 RED+GREEN (fake timers): heartbeat `: ping\n\n` cada 15s mientras la conexión está idle.
- [ ] C13 RED+GREEN: al `close` del request, el listener del cliente se remueve del bus (no queda suscripto — spy sobre `off`/`removeListener`).

### Composition-root
- [ ] C14 Actualizar el test de composición (A24) para incluir wiring de `AlertEventBus` + mount de `/stream`.

### FE — hook + panel
- [ ] C15 `ipnext-frontend/src/hooks/useAlerts.ts`: `EventSource` con `withCredentials`; al (re)conectar dispara `GET /api/alerts` completo ANTES de consumir eventos nuevos del stream (reconciliación, NO `Last-Event-ID`).
- [ ] C16 `useAlerts.ts`: `onerror` persistente → fallback a `refetchInterval` gateado por `useDocumentVisible()` (molde `useWhatsapp.ts:78-85`).
- [ ] C17 `AlertsPage.tsx`: filtros combinables fuente/severidad/estado con componente `Select` propio (NO `<select>` nativo) — reducen la lista visible.
- [ ] C18 `AlertsPage.tsx`: acción ACK abre `ConfirmModal`; solo dispara `POST /:id/acknowledge` si se confirma.
- [ ] C19 `AlertsPage.tsx`: 4 ramas de estado (loading/empty/error/success) mutuamente excluyentes.
- [ ] C20 `AlertsPage.tsx`: a11y — `aria-live` en la lista para altas por SSE, foco atrapado en el `ConfirmModal`.
- [ ] C21 `AlertsPage.tsx`: acción ACK oculta sin `<Can permission="monitoring.acknowledge_alert">`; panel completo oculto sin `<Can permission="monitoring.read">`.

## Fase D — Telegram bidireccional (`noc-alert-telegram`)

### Infra: gateway saliente
- [ ] D1 `src/infrastructure/adapters/telegram/TelegramBotGateway.ts` implementando `AlertNotifier` (port de A2): `notify(alert)` manda mensaje+botón inline `ack:<id>`; `editAck(alert)` edita el mensaje existente.
- [ ] D2 Fake/spy de `AlertNotifier` (extiende A4) para tests de use-case.

### Flag `noc-alerts-telegram-send`
- [ ] D3 RED: flag `OFF` (default convivencia) + alerta `firing` nueva → `AlertNotifier.notify` NO se invoca.
- [ ] D4 RED: flag `ON` + alerta `firing` nueva → `AlertNotifier.notify` se invoca una vez; `telegramChatId`/`telegramMessageId` devueltos quedan guardados en el `NocAlert`.
- [ ] D5 GREEN: leer el flag vía `FeatureFlagRepository` (in-memory en tests) antes de invocar el notifier, cableado en `IngestAlert`/`composeAlertsModule`.

### Webhook entrante
- [ ] D6 RED (supertest): `POST /api/alerts/telegram/webhook` sin/con `X-Telegram-Bot-Api-Secret-Token` inválido → `401`, ningún ACK registrado.
- [ ] D7 RED: secret válido + callback `ack:<id>` de un `NocAlert` existente → `AcknowledgeAlert` invocado, `ackBy`/`ackAt` seteados.
- [ ] D8 RED: secret válido + callback de un `id` inexistente → respuesta que no reintenta indefinidamente (definir código en la implementación), sin crear/modificar ningún `NocAlert`.
- [ ] D9 GREEN: montar `/telegram/webhook` en `alerts.routes.ts` con middleware de secret-token, parsear `callback_query`, delegar a `AcknowledgeAlert`.

### ACK bidireccional — edición del mensaje
- [ ] D10 RED: `AcknowledgeAlert` sobre un `NocAlert` CON `telegramChatId`/`telegramMessageId` → invoca `AlertNotifier.editAck`.
- [ ] D11 RED: `AcknowledgeAlert` sobre un `NocAlert` SIN metadata de Telegram (creado con flag `OFF`) → `editAck` NO se invoca.
- [ ] D12 RED: doble ACK (ya ackeado) desde el canal contrario → idempotente, no pisa `ackBy`/`ackAt` original, no dispara un segundo `editAck` con error visible.
- [ ] D13 GREEN: cablear la llamada a `AlertNotifier.editAck` dentro de `AcknowledgeAlert` (condicional a metadata presente).

### Config + composition-root
- [ ] D14 `config.ts`: fail-fast de `telegramBotToken`/`telegramWebhookSecret` al import.
- [ ] D15 Actualizar el test de composición (A24/C14) para incluir wiring de `TelegramBotGateway` + mount del webhook.

## Fase E (lado HUB) — Contrato colector fibra + umbrales

> El código del colector Rust (repo `ipnext-noc-collector`, deploy VM 130, key SSH
> `ipnext_flows`) NO se descompone acá — lo maneja otro agente en ese repo. Estas
> tasks son SOLO lo que el HUB debe aceptar/servir.

### `noc-fiber-collector-ingest` (contrato de ingesta, lado hub)
- [ ] E1 RED (supertest): `POST /api/alerts/ingest` con `fiberIngestKey`, `entity.type: "pon"`, `status: "firing"` → crea `NocAlert` `source: "fiber-collector"`, `entityType: "pon"`.
- [ ] E2 RED: `entity.type: "onu"` (drop individual) → crea `NocAlert` `entityType: "onu"`.
- [ ] E3 RED: `status: "resolved"` para un `(source, fingerprint)` `firing` existente de fibra → cierra la misma fila (reusa el mecanismo genérico de A5, solo fixture nuevo).
- [ ] E4 Nota: NO reespecificar auth 401 (ya cubierta genéricamente en A19 con key por fuente) — solo fixtures con `fiberIngestKey`.

### `noc-alert-thresholds` (config editable, lado hub)
- [ ] E5 `prisma/schema.prisma`: modelo `NocAlertThresholdsConfig` singleton (`id: String @id @default("singleton")`) con `CRIT_DBM`/`WARN_DBM`/`DELTA_ALERT`/`PON_MIN_ABON`/`PON_DELTA`.
- [ ] E6 Migración aditiva + seed defaults (`-30`/`-27`/`2.0`/`2`/`1.5`, `ON CONFLICT DO NOTHING`).
- [ ] E7 `src/domain/ports/NocAlertThresholdsConfigRepository.ts` (get/update) + `PrismaNocAlertThresholdsConfigRepository.ts` + `InMemoryNocAlertThresholdsConfigRepository.ts`.
- [ ] E8 RED: `GetAlertThresholds` retorna los defaults sembrados cuando nunca se editó.
- [ ] E9 GREEN: `src/application/use-cases/alerts/GetAlertThresholds.ts`.
- [ ] E10 RED: `UpdateAlertThresholds` actualiza el singleton; payload incompleto/no-numérico → rechaza sin actualización parcial.
- [ ] E11 GREEN: `src/application/use-cases/alerts/UpdateAlertThresholds.ts`.
- [ ] E12 RED (supertest): `GET /api/alerts/thresholds` humano con `monitoring.manage` → `200`; sin el permiso → `403`.
- [ ] E13 RED (supertest): `GET /api/alerts/thresholds` con `fiberIngestKey` (máquina) → `200`; sin cookie ni key válida → `401`.
- [ ] E14 RED (supertest): `PUT /api/alerts/thresholds` humano con `monitoring.manage` → `200` actualiza; sin el permiso → `403`, sin cambios.
- [ ] E15 RED (supertest): `PUT /api/alerts/thresholds` vía `fiberIngestKey` (máquina) → rechazado (`401`/`403`), singleton sin cambios — la vía machine es solo lectura.
- [ ] E16 GREEN: montar `GET`/`PUT /thresholds` en `alerts.routes.ts` con auth dual (cookie+`requirePerm` para humano, `apiKeyMiddleware` solo-lectura para el colector).
- [ ] E17 Actualizar el test de composición (A24/C14/D15) con wiring de `NocAlertThresholdsConfigRepository` + rutas.
- [ ] E18 Nota (no-task, documentación): sync con reglas de Grafana vía su API = Fase F+, explícitamente fuera de alcance acá — `PUT` solo gobierna la fuente de verdad del hub/colector, no toca Grafana.

## Resumen

| Fase | Ítems | Foco |
|---|---|---|
| A | 24 | Fundación: entidad, ports, IngestAlert/AcknowledgeAlert/ListAlerts, DTO, Prisma+migración+flags, rutas+auth+RBAC, composition-root |
| B | 8 | Adapter Grafana (mapper + endpoint + validación + N-fingerprints), reusa auth de A |
| C | 21 | `AlertEventBus`+SSE `/stream` (auth cookie, headers, heartbeat, unsubscribe)+panel FE (filtros, ACK+ConfirmModal, 4 estados, a11y, permisos) |
| D | 15 | `TelegramBotGateway` saliente(flag)+webhook entrante(secret)+ACK bidireccional(editAck condicional+idempotencia) |
| E (hub) | 18 | Contrato ingesta fibra (PON/ONU/resolved, reusa auth) + `NocAlertThresholdsConfig` (singleton, auth dual humano/máquina, validación) |

**Pendiente**: E (código del colector Rust en sí, repo `ipnext-noc-collector`) — otro
agente, bloqueado por key SSH `ipnext_flows`. F+ = sync Grafana + otros vigías +
PagerDuty fino. Cutover = evento posterior con OK explícito del usuario (flip
`noc-alerts-telegram-send` ON + baja Grafana→Telegram + stop `noc_metrics.py`).
