# Tasks — chatwoot-hub-sendpath

**Change**: chatwoot-hub-sendpath · **Phase**: tasks · **Repo**: BE únicamente (este worktree,
`feat/chatwoot-hub-sendpath`). Sin FE — el contrato HTTP no cambia (DTO gana 2 campos aditivos,
D6), sin rutas nuevas.
**TDD estricto**: RED → GREEN → refactor. Adapters in-memory para use cases (`InMemory*Repository`,
`FakeChatwootGateway`), JAMÁS mockear Prisma ni el use case (lección #28 — seam completo).
**Flag `messaging-send-via-chatwoot`**: default OFF, resuelto por invocación (hilo) / por-batch
(bulk, D4) — nunca cacheado al boot ni por-campaña (D8).
**Dependencias entre batches**: B1 (schema/dto) → B2 (port/adapter) → {B3, B4} (use cases,
paralelizables entre sí una vez B2 está verde) → B5 (webhook, depende de B1.3 + B2) → B6 (wiring,
depende de B2/B3/B4/B5 completos).

---

## Batch 1 — Schema aditivo + DTO (D6, D10)

- [ ] **1.1** Migración `prisma migrate diff` (sin DB viva, mismo criterio que
  `chatmessage_provider_message_id`/`chatmessage_idempotency_key` de `inbox-template-send`):
  timestamp posterior a `20261017000000_messaging_bulk_status_permissions` (sugerido
  `20261018000000_chatwoot_sendpath_delivery_status`). Contenido:
  - `ALTER TABLE "ChatMessage" ADD COLUMN "deliveryStatus" TEXT, ADD COLUMN "deliveryError" TEXT;`
    (nullable, sin default — D6).
  - `INSERT INTO "FeatureFlag" ("key","enabled","updatedAt") VALUES
    ('messaging-send-via-chatwoot', false, NOW()) ON CONFLICT DO NOTHING;` (molde
    `20260917000100_radius_auto_cure_flag`, D10). Misma migración (o hermana en el mismo timestamp).
  - Nunca SQL a mano fuera de este INSERT idempotente (patrón ya usado en el repo).
- [ ] **1.2** `prisma/schema.prisma`: `ChatMessage.deliveryStatus String?` / `deliveryError String?`
  reflejados en el modelo (post prisma generate). — test: N/A (schema), verificado por 1.3.
- [ ] **1.3** `ChatMessageRecord` (`domain/ports/ChatMessageRepository.ts`) gana
  `deliveryStatus: 'failed' | null` y `deliveryError: string | null`. `toChatMessageDto`
  (`application/dto/messaging.ts`) los expone tal cual.
  - Test RED: extender el test de `toChatMessageDto` (shape completo, `toEqual`) con ambos campos
    en `null` (default) y en `'failed'`/`'algo'` — cubre MODEL-1/HIST-3 parcialmente.
- [ ] **Gate B1**: `npx prisma generate` limpio; suite de `application/dto` verde.

## Batch 2 — Extensión del `ChatwootGateway` (CHW-1, CHW-2, D2)

- [ ] **2.1** Port `domain/ports/ChatwootGateway.ts` gana:
  - `sendTemplateMessage(chatwootConversationId, {name, language, processedParams, content}):
    Promise<{chatwootMessageId, content}>` (D2.a).
  - `createConversationWithTemplate({phoneE164, name?, templateName, language, processedParams,
    content}): Promise<{chatwootConversationId, chatwootMessageId}>` (D2.b).
  - `registerWebhook` sigue igual; solo cambia el array de eventos en el adapter (2.3).
- [ ] **2.2** RED+GREEN `FakeChatwootGateway` (`__tests__/helpers/FakeChatwootGateway.ts`): implementa
  ambos métodos — arrays `sendTemplateMessageCalls`/`createConversationWithTemplateCalls` (molde
  `sendMessageCalls:44`), resultados configurables (`sendTemplateMessageResult`,
  `createConversationWithTemplateResult`) y flags `failSendTemplateMessage`/
  `failCreateConversationWithTemplate` (mismo criterio `ChatwootUnavailableError`-agnóstico: el fake
  lanza `Error` genérico, el use case es quien mapea). Sin test propio dedicado — se ejercita en
  B3/B4 (mismo patrón que el resto del fake).
- [ ] **2.3** RED `HttpChatwootGateway.test.ts` — 2 describes nuevos:
  - `sendTemplateMessage`: POST `accountPath('/conversations/:cid/messages')` con body EXACTO
    `{content, message_type:'outgoing', template_params:{name, language, processed_params}}`
    (`processedParams` mapeado 1:1 sin transformación, CHW-1); retorna `{chatwootMessageId:data.id}`
    vía `toMessageDto`; cualquier falla axios (red/timeout/4xx/5xx) → `ChatwootUnavailableError`.
  - `createConversationWithTemplate`: POST `accountPath('/conversations')` con
    `{inbox_id, source_id:'whatsapp:'+phoneE164, message:{content, template_params:{...}}}`
    (CHW-2); reuso de contacto verificado (mismo `source_id` → NO segundo POST de contacto si
    Chatwoot no lo exige); `chatwootMessageId` extraído de la respuesta del create.
  - GREEN: implementación en `HttpChatwootGateway.ts` (reusa `accountPath`/`toMessageDto`/el wrapper
    `this.call` de errores existente — cero código de manejo de error nuevo).
- [ ] **2.4** RED+GREEN `HttpChatwootGateway.registerWebhook` — extender el array de eventos
  suscriptos con `'message_updated'` (D2.c/D6); test que pinea el array completo
  (`['message_created','conversation_created','conversation_status_changed','message_updated']`).
- [ ] **Gate B2**: suites `HttpChatwootGateway.test.ts` + helpers verdes; `tsc --noEmit` limpio
  (el port nuevo no rompe ningún implementor existente).

## Batch 3 — `SendTemplateMessage` flag-aware (CHW-1/3/4/6/7, TS-5/TS-6 MODIFIED, D3)

- [ ] **3.1** Error nuevo `ConversationNotLinkedError` (`domain/errors/messaging.ts`, code
  `CONVERSATION_NOT_LINKED`, 422) + entry en el statusMap del errorHandler — molde
  `ConversationPhoneMissingError`. Test: vía el use-case test (3.2), sin test standalone (mismo
  criterio que `MESSAGING_WINDOW_EXPIRED` — no hay `messaging.errorHandler.test.ts` dedicado).
- [ ] **3.2** RED completo — extender `SendTemplateMessage.test.ts` con
  `InMemoryFeatureFlagRepository` + `FakeChatwootGateway` inyectados:
  - flag OFF (default, sin setear nada): comportamiento BYTE-IDÉNTICO al actual — MISMOS asserts
    ya verdes siguen pasando sin tocarlos (CHW-3 scenario "byte-idéntico").
  - flag ON + `chatwootConversationId` presente: llama `chatwootGateway.sendTemplateMessage(cid,
    {name:template.friendlyName, language:template.language, processedParams:variables, content})`
    (args exactos, `toEqual`); persiste vía `messageRepo.upsertByChatwootMessageId({chatwootMessageId,
    conversationId, direction:'outbound', content, senderName, chatwootCreatedAt, idempotencyKey})`
    (TS-6 modified); CERO llamada a `upsertTemplateMessage` (PORT-1 scenario).
  - flag ON + `chatwootConversationId:null`: 422 `ConversationNotLinkedError`, CERO llamada al
    gateway (CHW-1 guard).
  - guard 0 (idempotencyKey) funciona IGUAL en ambos flags (CHW-4/TS-6 scenario retry).
  - convergencia del eco: pre-write `upsertByChatwootMessageId({chatwootMessageId:555})` + un
    segundo upsert manual con el MISMO id (simulando el webhook) → UNA sola fila (CHW-4 scenario).
  - gate de aprobación (`TemplateNotApprovedError`) corre ANTES de construir `template_params.name`
    sin importar el flag — CERO POST a Chatwoot si no aprobado (CHW-6).
  - `chatwootGateway` lanza error → `ChatwootUnavailableError` propaga, CERO persistencia (CHW-7).
  - `bumpLastMessage` se llama en AMBOS paths, nunca toca canReply/status (D2 inbox-template-send,
    regresión-check).
- [ ] **3.3** GREEN — `SendTemplateMessage.ts`: constructor gana `chatwootGateway: ChatwootGateway` +
  `featureFlags: FeatureFlagRepository` (2 args nuevos AL FINAL). Orden de guards PINNED D3: guard 0
  intacto → `findById` → lectura del flag → guard de teléfono (OFF) / guard de
  `chatwootConversationId` (ON) → guard de aprobación (intacto) → guard de variables (intacto) →
  envío condicional (OFF: `templatePort.sendTemplate`; ON: `chatwootGateway.sendTemplateMessage`) →
  persistencia condicional (OFF: `upsertTemplateMessage`; ON: `upsertByChatwootMessageId`) →
  `bumpLastMessage` intacto → `toChatMessageDto`. `renderedBody` se computa ANTES del send en el
  path ON (D3, `content` lo necesita); sigue post-OK en OFF.
- [ ] **3.4** `UpsertChatMessageInput` (`domain/ports/ChatMessageRepository.ts`) gana
  `idempotencyKey?: string | null` (D5, set-once en el CREATE, jamás pisado por el UPDATE del eco).
  - Test RED: `InMemoryChatMessageRepository.test.ts` — create con key → columna poblada; update
    idempotente del MISMO `chatwootMessageId` SIN key (simulando el eco) → la key original
    persiste intacta (set-once, mismo molde que `authorId`).
  - GREEN: `InMemoryChatMessageRepository.upsertByChatwootMessageId` + `PrismaChatMessageRepository`
    equivalente (cross-ref comment, ambos NO pueden divergir — molde backstop `@unique` H1).
  - Test RED+GREEN Prisma: `PrismaChatMessageRepository.upsertTemplateMessage.test.ts` o archivo
    hermano — pinea `create.data.idempotencyKey`/`update.data` (sin `idempotencyKey` en el update).
- [ ] **Gate B3**: `SendTemplateMessage.test.ts` + `InMemoryChatMessageRepository.test.ts` +
  adapters Prisma tocados, verdes.

## Batch 4 — `SendCampaign` flag-aware + `CampaignInboxProjector` (CHW-2/3/4, SEND-2/3/4, D4/D7/D9)

- [ ] **4.1** Port `CampaignInboxProjector` gana `projectChatwootTemplateSend(input: {recipient,
  contactName, contactPhone, chatwootConversationId, chatwootMessageId, renderedBody, sentAt}):
  Promise<void>` (D9), sin tocar `projectSentMessage` (intacto, path OFF).
- [ ] **4.2** RED+GREEN fake in-memory del projector (test helper) — gana
  `projectChatwootTemplateSendCalls` + implementación mínima; molde del fake existente de
  `projectSentMessage` si ya hay uno, si no crear `FakeCampaignInboxProjector` en
  `__tests__/helpers/`.
- [ ] **4.3** RED+GREEN `PrismaCampaignInboxProjector.projectChatwootTemplateSend`:
  - Test: pinea 3 pasos — `conversationRepo.upsertByChatwootId({chatwootConversationId,
    contactName, contactPhone})`; `chatMessageRepo.upsertByChatwootMessageId({conversationId:local.id,
    chatwootMessageId, direction:'outbound', content:renderedBody, senderName:null,
    chatwootCreatedAt:sentAt})`; `campaignRepo.updateRecipient(recipient.id,
    {conversationId:local.id})` (preserva el lazo recipient→conversación, D9).
  - GREEN: implementación en `PrismaCampaignInboxProjector.ts`.
- [ ] **4.4** RED completo — extender `SendCampaign.test.ts`:
  - flag OFF (constructor sin los 2 args nuevos, o con `featureFlags` ausente/`enabled:false`):
    comportamiento actual EXACTO, sin deps nuevas invocadas (backcompat, SEND-2/3/4 "sin cambios").
  - flag ON, recipient sin `chatwootConversationId`: dispara
    `chatwootGateway.createConversationWithTemplate({phoneE164, name:candidate.name,
    templateName:descriptor.friendlyName, language:descriptor.language, processedParams:variables,
    content})` (args exactos); `persistRecipientSent` con `providerId=String(chatwootMessageId)`;
    `projectChatwootTemplateSend` invocado (no `projectSentMessage`) — CHW-2/SEND-2 scenario.
  - descriptor de template resuelto UNA vez por run vía `templatePort.listTemplates()` +
    `find(contentSid===templateRef)`; si no existe o no `approved` con ON → `TemplateProviderConfigError`
    (aborta el run, D7) — test que verifica CERO recipients quemados a `failed`.
  - `rateLimiter.acquire()` se llama igual en ambos flags (SEND-4, sin cambios de contrato).
  - SIN `sendWithRetry` en el path ON (SEND-3 modified) — test que confirma que un fallo del
    gateway Chatwoot NO reintenta internamente, cae directo a `persistRecipientFailed`.
  - Chatwoot caído durante el batch → ESE recipient `failed` con error saneado; el resto sigue
    (CHW-7 bulk scenario); FIX-5 intacto (un `sent` nunca vuelve a `failed`).
  - flag leído UNA vez por batch (no por recipient) — test que cuenta invocaciones de
    `featureFlags.get` igual al número de páginas keyset, no al número de recipients.
- [ ] **4.5** GREEN — `SendCampaign.ts`: constructor gana `chatwootGateway?: ChatwootGateway` +
  `featureFlags?: FeatureFlagRepository` (2 args opcionales AL FINAL, después de `backoffOpts?` —
  ausentes = comportamiento OFF exacto). `drainQueue` lee el flag una vez por batch; `processRecipient`
  recibe `viaChat` + `templateDescriptor` y ramifica envío/persistencia/proyección según D4.
- [ ] **Gate B4**: `SendCampaign.test.ts` + `PrismaCampaignInboxProjector` tests verdes.

## Batch 5 — `message_updated` → `deliveryStatus='failed'` (CHW-5, D6)

- [ ] **5.1** Port: `ChatMessageRepository.markDeliveryFailedByChatwootMessageId(chatwootMessageId:
  number, error: string): Promise<ChatMessageRecord | null>` (idempotente, `null` si la fila no
  existe aún — no-op).
- [ ] **5.2** RED+GREEN `InMemoryChatMessageRepository` + `PrismaChatMessageRepository`:
  - Test: fila existente → `deliveryStatus='failed'` + `deliveryError` seteados, resto intacto;
    fila ausente → retorna `null`, CERO error; llamada repetida (mismo id) → idempotente (sin
    duplicar ni pisar otros campos).
- [ ] **5.3** RED — extender `ReceiveChatwootWebhook.test.ts`:
  - `ChatwootWebhookPayload` gana `content_attributes?: {external_error?: string | null}` — test
    de tipo/parsing (payload real de exploración §3).
  - `process` rutea `case 'message_updated'` → `handleMessageUpdated`.
  - `message_updated` CON `external_error` no-vacío → `markDeliveryFailedByChatwootMessageId(payload.id,
    curate(external_error))` — error saneado (sin headers/body crudo, HIST-3).
  - `message_updated` SIN `external_error` (o vacío) → no-op, `deliveryStatus` no cambia
    (delivered/read invisibles, CHW-5 scenario).
  - fila ausente en el mirror (mensaje aún no proyectado) → no-op seguro, sin lanzar.
  - `handleMessageUpdated` NUNCA lanza (HOOK-5) — webhook ackea 200 siempre.
- [ ] **5.4** GREEN — `ReceiveChatwootWebhook.ts`: `handleMessageUpdated` + función `curate`
  (trim/acota, sin PII de payload crudo — HIST-3).
- [ ] **Gate B5**: `ReceiveChatwootWebhook.test.ts` + adapters de B5.2 verdes.

## Batch 6 — Wiring `app.ts` + composition-root test + activación runtime (D1, D10, lección W6)

- [ ] **6.1** RED — extender/crear `messaging-composition.test.ts` (molde F3 de
  `inbox-template-send`, bootea `createApp()` real): afirma que (a) `SendTemplateMessage` y
  `SendCampaign` reciben una instancia de `FeatureFlagRepository`; (b) reciben una instancia de
  `ChatwootGateway` con `sendTemplateMessage`/`createConversationWithTemplate` presentes; (c) el
  `chatwootGateway` inyectado en `SendTemplateMessage` es la MISMA instancia que consume
  `GetConversation`/`SendMessage` (no un segundo cliente); (d) ambos use cases leen el MISMO key
  `messaging-send-via-chatwoot` (mock/spy sobre `get` si el test lo permite, o assert de
  construcción). Sin este test, el canal ON queda cableado a la nada en prod (lección W6).
- [ ] **6.2** GREEN — `app.ts`, bloque messaging (~`:2872-2926`): `new SendTemplateMessage(
  conversationRepo, sendTemplateGateway, chatMessageRepo, chatwootGateway, featureFlagRepo)` —
  `chatwootGateway` = la MISMA instancia ya cableada (`:2825`/consumida en `:2887`/`:2897`);
  `featureFlagRepo = new PrismaFeatureFlagRepository()` scope-local (molde bootstraps de
  scheduling, SIN compartir variable con el bloque bulk/CRUD — precedente anti-interleave de
  `inbox-template-send`).
- [ ] **6.3** GREEN — `app.ts`, bloque bulk (~`:2987-3005`): `new SendCampaign(campaignRepo,
  customerAdapter, templatePort, rateLimiter, campaignInboxProjector, undefined,
  chatwootGatewayForBulk, featureFlagRepoForBulk)` — `chatwootGatewayForBulk = new
  HttpChatwootGateway({...config.chatwoot})` (self-contained, mismo precedente que el gateway
  Twilio propio del bloque); `backoffOpts` explícito `undefined` para no correr los args opcionales.
- [ ] **6.4** GREEN — `HttpChatwootGateway.ts`/`registerWebhook` ya extendido en 2.4; correr
  `scripts/registerChatwootWebhook.ts` NO es parte de este batch (es paso de runbook, fuera del
  repo/CI).
- [ ] **Gate B6**: `npm test` completo BE verde. NO `npm run build` (regla del repo).

## Batch F (reservado) — Fix wave post-review adversarial

Sin tasks pre-definidas — se completa tras el review adversarial de B1-B6, siguiendo el molde de
`inbox-template-send` Batch F (severidad ALTO/MEDIO/LOW por finding).

---

## Riesgos / desvíos detectados en esta fase (spec↔design)

- **`idempotencyKey` NO requiere migración nueva**: la columna `ChatMessage.idempotencyKey` YA
  existe (`schema.prisma:3165`, de `inbox-template-send` fix wave F1) — D5 solo extiende
  `UpsertChatMessageInput`/el método del port para ACEPTAR la key en el path ON (Batch 3.4), sin
  tocar schema. El spec (MODEL-1) es compatible con esto ("sin cambios de schema en este delta").
- **`chatwootMessageId` en el create bulk (D2.b) puede degradar al eco del webhook** (riesgo 3 del
  design) — Batch 2.3 implementa el intento síncrono; si el shape real de Chatwoot no expone el id
  de forma fiable, el fallback documentado (eco `message_created` pobla el mirror igual) no requiere
  código adicional en este change — se deja como nota para el E2E vivo de cierre.
- **CampaignRecipient async-failed deferido (D6)** — Batch 5 NO re-flipea `CampaignRecipient.status`
  sent→failed; paridad con el comportamiento actual, consistente con spec CHW-5 (solo el
  `ChatMessage` se marca failed).

---

## Activación (runbook, fuera del repo) — checklist del operador/orquestador, NO tasks de código

- [ ] Deploy con la migración de B1 (flag OFF) — comportamiento sin cambios.
- [ ] Re-correr `scripts/registerChatwootWebhook.ts` (o UI de Chatwoot) para suscribir
  `message_updated` al endpoint HMAC-gated existente.
- [ ] Configurar cron en el host del VPS (fuera del repo): `docker exec <chatwoot> bundle exec
  rails runner "Channels::Twilio::TemplatesSyncJob.perform_now(1)"` cada 15 min.
- [ ] Sync inicial manual + verificación read-only de `channel.content_templates` (> 5 templates,
  friendly_names reales) — BLOQUEANTE antes de tocar el flag.
- [ ] Smoke test con flag ON (1 conversación desde el hilo): aparece en Chatwoot; mirror upsertea
  por `chatwootMessageId`; un template inválido aflora `deliveryStatus='failed'` vía webhook.
- [ ] Flip gradual: ON para hilo primero; luego bulk chico (5-10 recipients); verificar
  `recipient.conversationId` + cola Sidekiq de Chatwoot.
- [ ] Rollback disponible: togglear el flag OFF revierte a Twilio-directo sin deploy. Criterio:
  `external_error` masivo, cola Sidekiq desbordada, o cualquier anomalía de entrega.
