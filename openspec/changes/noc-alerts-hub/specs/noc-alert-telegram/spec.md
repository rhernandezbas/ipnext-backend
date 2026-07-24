# Noc Alert Telegram Specification

## Purpose

Bot de Telegram del hub: envío SALIENTE de una alerta `firing` con botón inline
("me encargo", `callback_data: ack:<id>`), y webhook ENTRANTE
`POST /api/alerts/telegram/webhook` que recibe los callbacks de ese botón. **ACK
bidireccional**: ackear desde Telegram O desde el panel escribe un ÚNICO estado en el
hub (`ackBy`/`ackAt`) y refleja ese estado en AMBOS canales — edita el mensaje de
Telegram y publica al SSE (`noc-alert-realtime`). El envío saliente está gobernado por
el flag `noc-alerts-telegram-send` (`FeatureFlag` DB-backed, molde
`chatwoot-hub-sendpath`), **OFF durante la convivencia**: mientras esté OFF, el hub NO
manda nada a Telegram — `noc_metrics.py` (VM 130) y el contact-point Grafana→Telegram
existente siguen siendo los únicos canales que notifican. Ningún escenario de esta
capability apaga, modifica o reemplaza esos sistemas; el cutover (flip del flag a ON +
baja de los canales viejos) es un evento posterior explícito, fuera de alcance de este
spec.

## Requirements

### Requirement: Outbound Telegram notification gated by feature flag
El sistema DEBE (MUST) invocar `AlertNotifier.notify(alert)` (implementado por
`TelegramBotGateway`) cuando una alerta pasa a `firing` **solo si** el flag
`noc-alerts-telegram-send` está `ON`; si está `OFF` (estado de convivencia), NO DEBE
(MUST NOT) invocarlo bajo ninguna circunstancia.

#### Scenario: Flag ON sends a Telegram message with an inline button
- GIVEN el flag `noc-alerts-telegram-send` está `ON`
- WHEN `IngestAlert` persiste un `NocAlert` nuevo con `status: firing`
- THEN se invoca `AlertNotifier.notify` y se envía un mensaje a Telegram con un botón inline cuyo `callback_data` es `ack:<id>` del `NocAlert`; el hub guarda `telegramChatId`/`telegramMessageId` devueltos

#### Scenario: Flag OFF sends nothing (convivencia)
- GIVEN el flag `noc-alerts-telegram-send` está `OFF` (default de convivencia)
- WHEN `IngestAlert` persiste un `NocAlert` nuevo con `status: firing`
- THEN NO se invoca `AlertNotifier.notify` — ningún mensaje sale a Telegram desde el hub

### Requirement: Inbound webhook requires a valid secret token
El sistema DEBE (MUST) exponer `POST /api/alerts/telegram/webhook` protegido por el
header `X-Telegram-Bot-Api-Secret-Token`, comparado contra `telegramWebhookSecret`
configurado, fail-closed.

#### Scenario: Webhook without or with invalid secret token is rejected
- GIVEN `telegramWebhookSecret` está configurado
- WHEN se hace `POST /api/alerts/telegram/webhook` sin el header `X-Telegram-Bot-Api-Secret-Token`, o con un valor que no coincide
- THEN responde `401` y no se registra ningún ACK

### Requirement: A Telegram button callback acknowledges the alert
El sistema DEBE (MUST), al recibir un callback válido `ack:<id>` en el webhook,
invocar `AcknowledgeAlert` para el `NocAlert` correspondiente, con `ackBy` derivado
del usuario/chat de Telegram que apretó el botón.

#### Scenario: Valid callback acknowledges the matching alert
- GIVEN `telegramWebhookSecret` es válido y existe un `NocAlert` `firing` sin ACK con ese `id`
- WHEN Telegram envía el callback `ack:<id>` al webhook
- THEN el `NocAlert` queda `ackBy`/`ackAt` seteados (mismo `AcknowledgeAlert` de `noc-alert-hub`, no un camino paralelo)

#### Scenario: Callback for a non-existent alert does not error the webhook
- GIVEN `telegramWebhookSecret` es válido pero NO existe ningún `NocAlert` con el `id` del callback
- WHEN Telegram envía ese callback
- THEN el webhook responde de forma que Telegram no reintente indefinidamente (2xx con `answerCallbackQuery` de error, o el código que defina la implementación) y NO se crea ni modifica ningún `NocAlert`

### Requirement: Acknowledge edits the Telegram message on either channel
El sistema DEBE (MUST) invocar `AlertNotifier.editAck(alert)` cuando un `NocAlert` con
`telegramChatId`/`telegramMessageId` seteados se ackea, sin importar si el ACK se
originó en el panel o en Telegram — un único estado, reflejado en ambos canales.

#### Scenario: Acknowledging from the panel edits the existing Telegram message
- GIVEN un `NocAlert` tiene `telegramChatId`/`telegramMessageId` seteados (se envió por Telegram con el flag ON) y no tiene ACK
- WHEN un usuario hace `POST /api/alerts/:id/acknowledge` desde el panel
- THEN se invoca `AlertNotifier.editAck` y el mensaje de Telegram queda editado reflejando "tomado por X"; el hub también publica el evento `acked` al SSE (`noc-alert-realtime`)

#### Scenario: Acknowledging from Telegram edits the same message
- GIVEN un `NocAlert` tiene `telegramChatId`/`telegramMessageId` seteados y no tiene ACK
- WHEN llega el callback `ack:<id>` desde Telegram (webhook)
- THEN se invoca `AlertNotifier.editAck` y el mensaje de Telegram queda editado con el ACK, consistente con el estado que ve el panel por SSE

#### Scenario: Acknowledging an alert without Telegram metadata does not attempt to edit
- GIVEN un `NocAlert` NO tiene `telegramChatId`/`telegramMessageId` (se creó con el flag `noc-alerts-telegram-send` en `OFF`, nunca se mandó a Telegram)
- WHEN se ackea desde el panel
- THEN NO se invoca `AlertNotifier.editAck` (no hay mensaje que editar) y el ACK persiste igual

### Requirement: Double acknowledge is idempotent across channels
El sistema NO DEBE (MUST NOT) fallar ni duplicar el ACK si llega un segundo intento de
ACK por el canal contrario al que ya lo reconoció.

#### Scenario: Second acknowledge attempt from the other channel is a no-op
- GIVEN un `NocAlert` ya tiene `ackBy`/`ackAt` seteados (ackeado desde un canal)
- WHEN llega un segundo intento de ACK para el mismo `id` desde el canal contrario (panel↔Telegram)
- THEN el `NocAlert` mantiene el `ackBy`/`ackAt` original (no se pisa con el segundo ackeador) y no se produce un error visible al usuario ni un segundo `editAck` duplicado

## Testing Notes

`TelegramBotGateway` se testea como adapter aislado (llamadas a la Telegram Bot API
mockeadas vía HTTP fake, no la librería real contra Telegram). El flag
`noc-alerts-telegram-send` se lee vía `FeatureFlagRepository` — usar
`InMemoryFeatureFlagRepository` (patrón ya existente en el repo, ver
`src/infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository.ts`), NUNCA
mockear Prisma. `AcknowledgeAlert` se testea con un `AlertNotifier` fake/spy para
verificar que `editAck` se invoca condicionalmente según haya o no metadata de
Telegram — no depende de si el ACK vino del panel o del webhook (mismo use-case, dos
puntos de entrada HTTP distintos). El webhook se testea con `supertest` sobre la app
real con `NocAlertRepository`/`AlertNotifier` in-memory.
