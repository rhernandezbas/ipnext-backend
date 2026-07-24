# Noc Alert Realtime Specification

## Purpose

Real-time del hub: `AlertEventBus` (infra, wrapper de `EventEmitter`) implementando
el port `AlertEventPublisher` (domain), SSE `GET /api/alerts/stream`, y el panel FE
(`AlertsPage`) que lo consume con fallback a polling. `IngestAlert`/`AcknowledgeAlert`
(Fase A) publican al bus DESPUÉS de persistir con éxito — el bus nunca es la fuente
de verdad, solo el canal de notificación. **Sigue en modo oscuro para Telegram**: esta
capability entrega SSE+panel únicamente, el envío saliente a Telegram es Fase D
(`noc-alert-telegram`, flag `noc-alerts-telegram-send` sigue OFF). Ningún escenario de
esta capability apaga o modifica los scripts Python de la VM 130 ni el Grafana→Telegram
existente — son sistemas ajenos al hub y no se tocan.

**Nota de reconexión** (alinea con `design.md` §Decisión SSE): el mecanismo de
reconexión es **refetch completo al (re)conectar**, NO `Last-Event-ID`/ring-buffer de
replay — el design consideró ese mecanismo over-engineering para el volumen actual y
lo dejó fuera. Los escenarios de reconexión de este spec reflejan esa decisión.

## Requirements

### Requirement: Use-cases publish to the event bus after persisting
El sistema DEBE (MUST) publicar un evento al `AlertEventPublisher` inmediatamente
después de que `IngestAlert` o `AcknowledgeAlert` persistan exitosamente, y NO DEBE
(MUST NOT) publicar si la persistencia falla.

#### Scenario: Ingesting a firing alert publishes a 'firing' event after persist
- GIVEN el hub tiene un `AlertEventBus` real cableado como `AlertEventPublisher`
- WHEN `IngestAlert` persiste un `NocAlert` nuevo con éxito
- THEN se publica al bus un evento `{ type: 'firing', alert }` con el `NocAlert` recién creado

#### Scenario: Acknowledging an alert publishes an 'acked' event after persist
- GIVEN el hub tiene un `AlertEventBus` real cableado como `AlertEventPublisher`
- WHEN `AcknowledgeAlert` persiste el ACK con éxito
- THEN se publica al bus un evento `{ type: 'acked', alert }` con el `NocAlert` actualizado

### Requirement: SSE stream requires session auth, not API key
El sistema DEBE (MUST) exponer `GET /api/alerts/stream` protegido por
`createAuthMiddleware` (cookie de sesión) + `requirePerm('monitoring.read')` — el
mismo molde que el resto de rutas de usuario del hub, NUNCA `apiKeyMiddleware` (ese es
machine-to-machine para ingesta).

#### Scenario: Stream connection without session cookie is rejected
- GIVEN no hay cookie de sesión válida en la request
- WHEN se hace `GET /api/alerts/stream`
- THEN responde `401` y no se abre el stream

#### Scenario: Stream connection without monitoring.read permission is rejected
- GIVEN un usuario autenticado (cookie válida) SIN `monitoring.read`
- WHEN hace `GET /api/alerts/stream`
- THEN responde `403` y no se abre el stream

#### Scenario: Stream connection with permission opens with correct SSE headers
- GIVEN un usuario autenticado con `monitoring.read`
- WHEN hace `GET /api/alerts/stream`
- THEN la respuesta tiene `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, header `X-Accel-Buffering: no`, y los headers se flushean inmediatamente (sin esperar el primer evento)

### Requirement: Connected clients receive alert events in real time
El sistema DEBE (MUST) escribir un frame SSE (`data: <json>\n\n`) a cada cliente
conectado al stream por cada evento publicado al bus mientras esa conexión siga
abierta.

#### Scenario: A new firing alert reaches a connected client
- GIVEN un cliente está conectado a `GET /api/alerts/stream`
- WHEN se ingiere un `NocAlert` nuevo (vía `/ingest` o `/ingest/grafana`) que dispara un evento `firing` en el bus
- THEN el cliente conectado recibe un frame SSE con el `NocAlertDto` de esa alerta

#### Scenario: An acknowledge from the panel reaches connected clients
- GIVEN un cliente está conectado a `GET /api/alerts/stream`
- WHEN otro usuario hace `POST /api/alerts/:id/acknowledge` sobre un `NocAlert` existente
- THEN el cliente conectado recibe un frame SSE con el evento `acked` y el `NocAlertDto` actualizado (`ackBy`/`ackAt` presentes)

### Requirement: Heartbeat keeps the connection alive through proxies
El sistema DEBE (MUST) enviar un comentario SSE de heartbeat (`: ping\n\n`) cada 15
segundos a cada cliente conectado, para evitar que el proxy corte la conexión por
inactividad.

#### Scenario: An idle connection still receives periodic heartbeats
- GIVEN un cliente está conectado a `GET /api/alerts/stream` y no se publica ningún evento de alerta
- WHEN pasan 15 segundos
- THEN el cliente recibe un frame de heartbeat (comentario, no un evento `data:` de alerta)

### Requirement: Disconnecting a client unsubscribes it from the bus
El sistema NO DEBE (MUST NOT) mantener un listener del bus vivo después de que un
cliente cierra la conexión — evita memory leak de listeners acumulados.

#### Scenario: Client disconnect removes its bus listener
- GIVEN un cliente está conectado a `GET /api/alerts/stream`
- WHEN el cliente cierra la conexión (evento `close` del request)
- THEN el listener de ese cliente se remueve del `AlertEventBus` (no queda suscripto)

### Requirement: FE reconnection reconciles via full refetch, not event replay
El sistema DEBE (MUST) hacer que el FE, al (re)conectar el `EventSource`, dispare un
`GET /api/alerts` completo para reconciliar el estado ANTES de seguir consumiendo
eventos del stream — no se implementa `Last-Event-ID`/replay (decisión de design,
over-engineering para el volumen actual).

#### Scenario: Reconnecting the EventSource triggers a full list refetch
- GIVEN el panel FE tenía un `EventSource` abierto que se cerró (ej. el proxy cortó la conexión)
- WHEN el FE abre un `EventSource` nuevo para reconectar
- THEN el hook dispara `GET /api/alerts` para reconciliar el estado antes de procesar nuevos eventos del stream

### Requirement: FE falls back to polling when the stream fails
El sistema DEBE (MUST) hacer que el FE, ante un error persistente del `EventSource`
(`onerror`), deje de confiar en el stream y arranque polling (`refetchInterval`
gateado por `useDocumentVisible()`, molde `useWhatsapp.ts:78-85`).

#### Scenario: EventSource error triggers polling fallback
- GIVEN el panel FE está usando `EventSource` para tiempo real
- WHEN el `EventSource` dispara `onerror` de forma persistente (el stream no se recupera)
- THEN el hook cambia a modo polling (`refetchInterval`) gateado por la pestaña visible, sin perder la lista ya cargada

### Requirement: Alerts panel with filters and ACK
El sistema DEBE (MUST) exponer un panel FE (`AlertsPage`) que liste `NocAlert` con
filtros combinables por fuente, severidad y estado, y permita hacer ACK con
confirmación explícita — solo visible/operable con los permisos correspondientes en
ambas capas (BE y FE).

#### Scenario: Filtering the panel by source, severity and status narrows the list
- GIVEN el panel tiene alertas de varias fuentes/severidades/estados cargadas
- WHEN el usuario selecciona un filtro de fuente, severidad y estado (componente `Select` propio del proyecto, no un `<select>` nativo)
- THEN la lista visible muestra solo las alertas que matchean los tres filtros

#### Scenario: Acknowledging from the panel requires explicit confirmation
- GIVEN el usuario tiene `monitoring.acknowledge_alert` y ve una alerta sin ACK
- WHEN hace click en "reconocer" para esa alerta
- THEN se abre un `ConfirmModal` y el ACK solo se envía (`POST /:id/acknowledge`) si el usuario confirma

#### Scenario: Panel renders the four state branches correctly
- GIVEN el panel puede estar en cualquiera de sus cuatro estados
- WHEN el estado es loading (carga inicial), empty (sin alertas que matcheen los filtros), error (falla el fetch inicial) o success (alertas cargadas)
- THEN el panel renderiza el bloque correspondiente a ese estado (spinner, mensaje de "sin alertas", mensaje de error con reintento, o la lista), de forma mutuamente excluyente

#### Scenario: Panel is accessible
- GIVEN el panel está en cualquier estado
- WHEN se navega/lee con teclado o lector de pantalla
- THEN la lista de alertas y las actualizaciones en vivo exponen roles/`aria-live` adecuados, y el `ConfirmModal` de ACK atrapa el foco

#### Scenario: Ack action is hidden without permission (FE) and rejected without permission (BE)
- GIVEN un usuario autenticado SIN `monitoring.acknowledge_alert`
- WHEN ve el panel
- THEN no ve la acción de ACK (`<Can permission="monitoring.acknowledge_alert">`) — y si de todas formas se intenta el `POST` directo, el BE responde `403` (ya cubierto en `noc-alert-hub`, no se reespecifica)

#### Scenario: Panel is hidden without read permission (FE) and rejected without read permission (BE)
- GIVEN un usuario autenticado SIN `monitoring.read`
- WHEN intenta acceder al panel
- THEN el FE no renderiza el panel (`<Can permission="monitoring.read">`) — y el BE ya rechaza `GET /api/alerts` y `GET /api/alerts/stream` con `403` (cubierto en `noc-alert-hub` y en este spec, no se reespecifica dos veces)

## Testing Notes

Unit: `IngestAlert`/`AcknowledgeAlert` con un `AlertEventPublisher` fake que registra
llamadas (spy), NO el `AlertEventBus` real — separa "el use-case publica" de "el bus
entrega". Integration (rutas): `supertest` no soporta streams reales fácilmente — usar
el patrón de leer chunks del `res` crudo (`http.request` o `node:http` directo) o un
helper que dispare eventos al bus y assertee los frames escritos; NO mockear
`EventEmitter`, usar el real. Heartbeat: fake timers (`jest.useFakeTimers`). FE:
Testing Library con `EventSource` mockeado (o `mock-event-source`) + fallback de
polling con fake timers, molde `useWhatsapp.test.ts` si existe. NO mockear Prisma en
ningún test de use-case — `InMemoryNocAlertRepository` (Fase A) sigue siendo el
adapter fake.
