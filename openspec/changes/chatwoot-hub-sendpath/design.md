# Design — chatwoot-hub-sendpath (Chatwoot = eje del send-path de templates)

> Base: `proposal.md` (decisiones A–E ya tomadas) + exploración `sdd/chatwoot-hub-sendpath/explore`
> (payloads verificados en vivo contra Chatwoot v4.13.0). Este design NO re-litiga A–E: diseña DENTRO
> de ellas. Todas las citas `archivo:línea` son del worktree BE en su estado actual.

## 0. Mapa del flujo (flag OFF = hoy · flag ON = Chatwoot)

Flag runtime `messaging-send-via-chatwoot` (default OFF). Se resuelve **al momento de cada envío**
(D8) — nunca se congela por campaña.

```
── SendTemplateMessage (hilo abierto, un mensaje) ──────────────────────────────────────
 guard 0 idempotencyKey  → findByIdempotencyKey (IGUAL en ambos paths)
 guard 1 findById conversation
 guard 3 approval → template (trae friendlyName + language, D7)
 guard 4 variables completas
 flag = featureFlags.get('messaging-send-via-chatwoot')?.enabled
   OFF ─ guard 2 phoneE164 → templatePort.sendTemplate(phone, sid, vars) ─ SM sid
        └ upsertTemplateMessage({providerMessageId: sid, idempotencyKey})     (hoy, D3)
   ON  ─ guard 2' chatwootConversationId≠null → chatwootGateway.sendTemplateMessage(cid, {name,language,processedParams})
        └ upsertByChatwootMessageId({chatwootMessageId, idempotencyKey})       (D3/D5)
 bumpLastMessage (preview, NUNCA canReply/status — D2 de inbox-template-send, intacto)

── SendCampaign.processRecipient (bulk, por destinatario) ──────────────────────────────
 candidate + re-check opt-out + resolveCampaignVariables  (IGUAL en ambos)
 rateLimiter.acquire()                                     (IGUAL — protege a Chatwoot, Riesgo 2)
   OFF ─ sendWithRetry(templatePort.sendTemplate(phone, sid, vars)) ─ SM sid
        └ persistRecipientSent(sent) → projectSentMessage (origin:'bulk', phone-keyed)  (hoy)
   ON  ─ chatwootGateway.createConversationWithTemplate({phoneE164,name,language,processedParams,content})
        └ persistRecipientSent(sent, providerId=chatwootMessageId)
          → projectChatwootTemplateSend (upsert Conversation por id REAL + upsertByChatwootMessageId + link recipient)

── Async, ambos paths (solo detecta failed) ────────────────────────────────────────────
 Chatwoot webhook message_updated (content_attributes.external_error)
   → ReceiveChatwootWebhook.handleMessageUpdated → markDeliveryFailedByChatwootMessageId
   → ChatMessage.deliveryStatus='failed' + deliveryError (D6). delivered/read INVISIBLES (proposal B).
```

---

## D1 — El seam del flag vive DENTRO del use case (branch send+persist por ports), NO en un adapter compuesto

**Decidido: el flag se lee en el use case (`FeatureFlagRepository.get`, un port) y el use case ramifica
entre dos ports de envío + dos caminos de persistencia.** Se RECHAZA el "adapter compuesto que implementa
`TemplateMessagingPort` y selecciona por flag en el composition root".

**Por qué se rechaza el composite adapter** (aunque la proposal §5 lo dejó como opción): un
`FlaggedTemplateMessagingGateway` solo puede encapsular el **envío** detrás de
`sendTemplate(to, sid, vars) → {providerId}`. Pero con el flip cambian TRES cosas, no una:

1. **La clave de dedup del mirror** pasa de `providerMessageId` (SM sid, `ChatMessageRepository.ts:130`)
   a `chatwootMessageId` (`:118`) — obligatorio para que el **eco** `message_created` del webhook
   converja en el MISMO upsert (proposal §4, verificado). Un composite que devuelve el chatwoot id
   dentro de `providerId` y persiste por `upsertTemplateMessage` crearía una fila keyada por
   `providerMessageId`, y el eco (`upsertByChatwootMessageId`) crearía una SEGUNDA fila (otra columna
   `@unique`) → **duplicado en el hilo**. El cambio de clave NO se puede esconder detrás del retorno de
   `sendTemplate`.
2. **El destino de la conversación** difiere: el hilo apunta a un `chatwootConversationId` YA existente;
   el bulk hace find-or-create por teléfono. El port actual `sendTemplate(to,…)` solo carga el teléfono
   — no tiene dónde meter el `chatwootConversationId` del hilo abierto.
3. **La proyección al inbox** difiere (D9): `CampaignInboxProjector` phone-keyed vs upsert por id real.

Como send + persist + destino cambian juntos, la decisión es **lógica de aplicación** ("¿por qué canal
sale este mensaje y qué persisto?"), no un detalle de infraestructura ocultable. Meterla en el use case
es lo honesto y **sigue respetando DIP**: el use case depende SOLO de ports (`FeatureFlagRepository`,
`TemplateMessagingPort`, `ChatwootGateway`, `ChatMessageRepository`, `CampaignInboxProjector`) —
cero Prisma/axios, 100% fakeable in-memory. El envío nunca ve JSON crudo (los adapters mapean).

**Wiring exacto (`app.ts`)** — se cablean AMBOS canales (doble-path transitorio, proposal §C/Riesgo 7):

- Bloque messaging (~`app.ts:2872-2926`): `SendTemplateMessage` gana 2 args →
  `new SendTemplateMessage(conversationRepo, sendTemplateGateway, chatMessageRepo, chatwootGateway, featureFlagRepo)`.
  `chatwootGateway` es la MISMA instancia F1 ya cableada (`:2887/:2897`); `sendTemplateGateway`
  (`TwilioContentGateway`, `:2872`) queda como path OFF. `featureFlagRepo = new PrismaFeatureFlagRepository()`
  (scope-local, molde de los bootstraps de scheduling).
- Bloque bulk (~`app.ts:2987-3006`): `SendCampaign` gana 2 args →
  `new SendCampaign(campaignRepo, customerAdapter, templatePort, rateLimiter, campaignInboxProjector, backoffOpts?, chatwootGatewayForBulk, featureFlagRepo)`.
  `chatwootGatewayForBulk = new HttpChatwootGateway({...config.chatwoot})` (self-contained, mismo
  precedente que el gateway Twilio propio del bloque, `:2869-2876`). Los args nuevos van al FINAL de la
  firma (nunca en medio — lección de colisiones de `inbox-template-send`).

**Composition-root test que lo pinea** (lección W6 — el wiring se verifica a mano y se congela con test):
un test de `app.ts`/composición que afirma que (a) ambos use cases reciben una instancia de
`FeatureFlagRepository`; (b) reciben una instancia de `ChatwootGateway` con los métodos nuevos; (c) el
`chatwootGateway` del hilo es la MISMA instancia que consume `GetConversation`/`SendMessage` (no un
segundo cliente que apunte a otro inbox); (d) leen el MISMO key `messaging-send-via-chatwoot`. Sin este
test, el flag queda MUERTO en prod (canal ON cableado a la nada) y nadie se entera hasta el smoke.

---

## D2 — Extensión del `ChatwootGateway` (proposal §2/§5): dos métodos nuevos, firmas y payloads exactos

Se EXTIENDE el port existente `domain/ports/ChatwootGateway.ts` (`:88-149`) — no un port nuevo (la
proposal lo decidió; ISP-tradeoff aceptado: el hilo y el bulk ya dependen del gateway). `HttpChatwootGateway`
implementa ambos; `FakeChatwootGateway` (`__tests__/helpers/FakeChatwootGateway.ts:27`) los espeja.

### D2.a — `sendTemplateMessage` (path del hilo — conversación existente)

```ts
sendTemplateMessage(
  chatwootConversationId: number,
  params: { name: string; language: string; processedParams: Record<string, string>; content: string },
): Promise<{ chatwootMessageId: number; content: string }>;
```

- **HTTP**: `POST accountPath('/conversations/{cid}/messages')` (reusa `accountPath`, `HttpChatwootGateway.ts:120`)
  con body JSON:
  ```json
  { "content": "<renderedBody>", "message_type": "outgoing",
    "template_params": { "name": "<friendlyName>", "language": "es", "processed_params": {"1":"…"} } }
  ```
  Shape verificado (exploración §5): Chatwoot resuelve por `name+language` contra `channel.content_templates`,
  NO por content_sid. `processed_params` = nuestro `Record<string,string>` ya resuelto, mapeo 1:1 (cero
  transformación). `message_type:'outgoing'` (NO 'template') → el eco cae como `direction:'outbound'`
  normal (exploración §4), reusable por `upsertByChatwootMessageId`.
- **Retorno**: `chatwootMessageId = data.id` (mapeo por el MISMO `toMessageDto`, `HttpChatwootGateway.ts:379`).
- **Errores**: cualquier fallo de axios (red/timeout/4xx/5xx) → `ChatwootUnavailableError` (convención
  única del port, `:124-130`). **OJO semántico verificado (exploración §3)**: un template inexistente/
  fuera-de-ventana devuelve **201** igual (Chatwoot marca `failed` async), así que NO hay error síncrono
  para "template no resuelto" — eso aflora por `message_updated` (D6). El único 4xx síncrono realista es
  `cid` inválido (404) → `ChatwootUnavailableError`.

### D2.b — `createConversationWithTemplate` (path bulk — find-or-create atómico)

```ts
createConversationWithTemplate(
  params: { phoneE164: string; name?: string | null; templateName: string; language: string;
            processedParams: Record<string, string>; content: string },
): Promise<{ chatwootConversationId: number; chatwootMessageId: number }>;
```

- **HTTP (1-2 llamadas encapsuladas en el adapter)**: `POST accountPath('/conversations')` con
  `{ inbox_id, source_id: 'whatsapp:'+phoneE164, contact_id?, message: { content, template_params:{…} } }`.
  El `before_action :contact_inbox` hace find-or-create por `source_id` y crea el primer mensaje en la
  MISMA transacción (exploración §6). `source_id = 'whatsapp:+E164'` coincide EXACTO con `toWhatsAppE164`.
  Si Chatwoot exige `contact_id`, el adapter hace primero un find-or-create de contacto
  (`POST /contacts` con `{name, phone_number}`) — detalle interno del adapter, invisible al use case.
- **Retorno**: `chatwootConversationId = data.id`; `chatwootMessageId` se extrae de la respuesta del
  create (primer mensaje). **Degradación**: si la respuesta no expone el message id de forma fiable, el
  adapter puede devolver el `chatwootMessageId` del follow-up de `listMessages` o, en última instancia,
  el eco `message_created` del webhook igual pobla el mirror (bulk NO es interactivo, no hay FE esperando
  síncronamente) — se documenta como fallback aceptable.
- **Errores**: mismo criterio único → `ChatwootUnavailableError`. En el bulk lo captura
  `persistRecipientFailed` (`SendCampaign.ts:251`) como fallo per-destinatario — no aborta el lote.
  Excepción: si querés paridad con `TemplateProviderConfigError` (abortar el run ante misconfig
  sistémico), ver D7 (el guard de descriptor de template al inicio del run cubre eso).

### D2.c — Suscripción `message_updated`

`registerWebhook` (`HttpChatwootGateway.ts:211-219`) hoy suscribe
`['message_created','conversation_created','conversation_status_changed']`. Se AGREGA `'message_updated'`
(D6). Como `registerWebhook` lo corre un script one-shot (`scripts/registerChatwootWebhook.ts`),
activarlo es un paso del runbook (§Activación).

---

## D3 — `SendTemplateMessage` flag-aware (orden de guards actualizado; guard 0 y D2 de inbox-template-send INTACTOS)

Firma nueva: `execute(conversationId, templateRef, variables, senderName?, idempotencyKey?)` — sin cambios
de wire (proposal §D). Constructor gana `chatwootGateway: ChatwootGateway` y `featureFlags: FeatureFlagRepository`.

Orden PINNED (referencia `SendTemplateMessage.ts:74-138`) — el flag se lee justo DESPUÉS de `findById`
(guard 1), y el guard de teléfono/link (guard 2, ramificado por el flag) corre ANTES del gate de
aprobación (guard 3) y de variables (guard 4). La lista de abajo está en ORDEN DE EJECUCIÓN real (los
números son la etiqueta histórica del guard, no su posición):

0. **idempotencyKey fast-path** (`:87-93`) — `messageRepo.findByIdempotencyKey` → HIT devuelve `deduped:true`.
   **INTACTO en ambos paths** (D5 hace que el path ON también persista la key).
1. `conversationRepo.findById` → 404 (`:95-96`). INTACTO.
- **`const viaChat = (await featureFlags.get('messaging-send-via-chatwoot'))?.enabled === true;`** (leído
  acá, tras `findById` y ANTES de los guards 2/3/4).
2. **Teléfono / link — condicional al path** (corre ANTES del gate de aprobación, orden PINNED D9 de
   inbox-template-send — verificado por el test H4):
   - `viaChat === false`: guard actual (`:98-99`) — `phoneE164` con fallback `toWhatsAppE164`; ambos null → 422 `ConversationPhoneMissingError`.
   - `viaChat === true`: se requiere `conversation.chatwootConversationId != null`. Es null SOLO en un mirror
     `origin:'bulk'` nunca adoptado — un hilo que el agente abre SIEMPRE lo tiene. Null → 422
     `ConversationNotLinkedError` (nuevo, code `CONVERSATION_NOT_LINKED`, statusMap + doc del archivo de
     errores). El teléfono NO se necesita para el send por Chatwoot (targetea el cid).
3. `templatePort.listTemplates()` → `template` aprobado (`:102-106`). **INTACTO** — el gate de aprobación
   sigue contra Twilio Content API (D7). De acá salen `template.friendlyName`/`template.language` (D7).
4. Variables completas (`:108-113`). INTACTO.
5. **Envío (sin retry — D6 de inbox-template-send, interactivo):**
   - OFF: `templatePort.sendTemplate(phoneE164, templateRef, variables)` → `result.providerId`.
   - ON: `chatwootGateway.sendTemplateMessage(chatwootConversationId, { name: template.friendlyName,
     language: template.language, processedParams: variables, content: renderedBody })` → `chatwootMessageId`.
     `ChatwootUnavailableError` propaga → 503 (statusMap existente).
6. **Persistencia (D5):**
   - OFF: `messageRepo.upsertTemplateMessage({ providerMessageId: result.providerId, idempotencyKey, … })` (hoy).
   - ON: `messageRepo.upsertByChatwootMessageId({ chatwootConversationId→conversationId local, chatwootMessageId,
     direction:'outbound', content: renderedBody, senderName, chatwootCreatedAt: sentAt, idempotencyKey })`.
7. `bumpLastMessage(conversationId, {lastMessageAt, lastMessagePreview: renderedBody})` — **INTACTO**
   (`:132-135`), jamás toca canReply/status (D2 de inbox-template-send, regla de plataforma verificada).
8. `return { message: toChatMessageDto(record, []), deduped: false }`.

`renderedBody = renderTemplateBody(template.body, variables)` (`SendCampaign.ts:333`, reuso, pura/total)
se computa ANTES del send en el path ON (Chatwoot necesita `content`); en el OFF sigue post-OK (`:120`).
Reordenarlo es inocuo (función total, sin side-effects).

---

## D4 — `SendCampaign` flag-aware + extensión del `CampaignInboxProjector`

Constructor gana `chatwootGateway?: ChatwootGateway` y `featureFlags?: FeatureFlagRepository` (opcionales,
molde del `inboxProjector` 5º arg, `SendCampaign.ts:64` — sin ellos = comportamiento OFF exacto,
backcompat). El flag se lee **una vez por batch** en `drainQueue` (`:101-119`), no por recipient:

```ts
const viaChat = (await this.featureFlags?.get('messaging-send-via-chatwoot'))?.enabled === true;
// … pasar viaChat a processRecipient(campaign, recipient, viaChat, templateDescriptor)
```

Racional de "por batch": leer el flag por-destinatario serían 50-100k reads en el hot loop; leerlo por
batch (RESUME_PAGE_SIZE=25, `:22`) es indistinguible operativamente (staleness < 1s a ~80 msg/s) sin
martillar la DB. Es la implementación honesta de "resuelto al momento del envío, sin estado por campaña"
(D8) — refina el hint per-mensaje de la proposal §6 sin contradecirlo.

En `processRecipient` (`:121-187`), tras `resolveCampaignVariables` (`:156`):
- `rateLimiter.acquire()` — **INTACTO en ambos** (`:160`; con ON protege a Chatwoot, no a Twilio — Riesgo 2 aceptado).
- **Envío:**
  - OFF: `sendWithRetry(() => templatePort.sendTemplate(recipient.phoneE164, campaign.templateRef, variables))` (hoy).
  - ON: `chatwootGateway.createConversationWithTemplate({ phoneE164: recipient.phoneE164,
    name: candidate.name, templateName: descriptor.friendlyName, language: descriptor.language,
    processedParams: variables, content: renderTemplateBody(campaign.templateBody, variables) })`
    → `{chatwootConversationId, chatwootMessageId}`. (Sin `sendWithRetry`: el retry 429-aware era Twilio-
    facing; con ON el throttle real lo maneja Sidekiq de Chatwoot — SEND-3 MODIFIED, ver D11.)
- **Persistencia del recipient** (`persistRecipientSent`, `:226-248`) — **INTACTA**; con ON,
  `providerId = String(chatwootMessageId)` (auditoría). FIX-5 (un envío aceptado nunca vuelve a
  `failed`) sigue vigente.
- **Proyección al inbox** (`projectToInbox`, `:195-223`, best-effort/aislada — su fallo NUNCA re-marca `failed`):
  - OFF: `inboxProjector.projectSentMessage(...)` (hoy, phone-keyed, `origin:'bulk'`).
  - ON: `inboxProjector.projectChatwootTemplateSend(...)` (D9, nuevo método del port).

`templateDescriptor` (`{friendlyName, language}`) se resuelve **una vez por run** con ON (ver D7) —
el `Campaign` guarda `templateRef` + `templateName` (`campaign.ts:69-70`) pero NO `language`.

---

## D5 — Idempotencia dual con el flag (clave de mensaje) + idempotencyKey de request en ambos paths

Dos niveles de dedup, ortogonales, ambos con `@unique` NULL-tolerante (PG trata NULLs como distintos):

| Nivel | OFF | ON | Propósito |
|---|---|---|---|
| **Request (HTTP)** | `idempotencyKey` (`ChatMessageRecord.idempotencyKey`, `:35`) | **mismo** `idempotencyKey` | guard 0: retry del MISMO request no re-envía (doble costo) |
| **Mensaje (proveedor)** | `providerMessageId` (SM sid, `:26`) | `chatwootMessageId` (`:9`) | dedup del eco / re-proyección |

**Cambio de modelo mínimo**: `upsertByChatwootMessageId` (`ChatMessageRepository.ts:118`,
`UpsertChatMessageInput` `:49-64`) gana un campo **opcional** `idempotencyKey?: string | null`
(**set-once en el CREATE**, jamás pisado por el UPDATE idempotente del eco — misma disciplina que
`authorId`, `:58-63`). Así el guard 0 (`findByIdempotencyKey`, `:140`) funciona idéntico con ON: nuestro
pre-write crea la fila CON la key; el eco `message_created` (que NO manda `idempotencyKey`) la deja
intacta (set-once). Ambos adapters (`InMemory`/`Prisma`ChatMessageRepository) implementan la MISMA
semántica (cross-ref en el código, no pueden divergir — molde del backstop `@unique` de H1).

**Convergencia del eco (verificada, proposal §4)**: pre-write `upsertByChatwootMessageId({chatwootMessageId})`
+ eco posterior `upsertByChatwootMessageId({chatwootMessageId})` = upsert IDÉNTICO por la misma UNIQUE →
no-op/update, sin duplicar. El orden no importa (ambos son upserts).

**Campaña con paths mixtos** (flip a mitad, D8): unos recipients quedan keyados por `chatwootMessageId`
(ON) y otros por `providerMessageId`/`campaignRecipientId` (OFF). Son columnas `@unique` DISTINTAS y
NULL-tolerantes → cero colisión. Consistente por diseño.

---

## D6 — Estados: `message_updated` → `deliveryStatus='failed'` (paridad con hoy: sent/failed; delivered/read OUT)

Aceptado en proposal B. `sent` es implícito (mensaje registrado, optimista); `failed` se detecta async;
`delivered`/`read` INVISIBLES vía webhook (payload indistinguible, verificado exploración §3) — **no es
regresión** (el BE no tiene ruta de status-callback hoy, y Chatwoot pisa el callback per-mensaje hacia SU
endpoint).

### Delta de schema (aditivo, nullable)

Migración aditiva sobre `ChatMessage` (timestamp posterior a toda migración hermana en vuelo):
- `deliveryStatus String?` — `null` (default = entregado a Chatwoot / desconocido) | `'failed'`.
- `deliveryError String?` — texto curado del error (ver sanitización abajo).

`ChatMessageRecord` gana ambos; `toChatMessageDto` los expone (**aditivo** — el FE renderiza el badge
`failed` desde el mirror que ya poll-ea; contrato de request/response de envío INTACTO, proposal §D).
Nuevo método de port: `markDeliveryFailedByChatwootMessageId(chatwootMessageId: number, error: string):
Promise<ChatMessageRecord | null>` (idempotente; `null` si la fila no está en el mirror aún — no-op).

### Extensión de `ReceiveChatwootWebhook`

- `ChatwootWebhookPayload` (`ReceiveChatwootWebhook.ts:67-88`) gana
  `content_attributes?: { external_error?: string | null }` (verificado que viaja en `webhook_data`,
  exploración §3). El `id` top-level = message id (mismo que `message_created`).
- `process` (`:155-166`) gana `case 'message_updated': return this.handleMessageUpdated(payload);`.
- `handleMessageUpdated`: si `payload.id != null` y `content_attributes.external_error` está poblado y
  no-vacío → `messageRepo.markDeliveryFailedByChatwootMessageId(payload.id, curate(external_error))`.
  Sin `external_error` (o vacío) → no-op (delivered/read caen acá y son indistinguibles — se ignoran).
  Payload malformado (`id` ausente) → no-op (nunca será un retry válido).
- **Linkeo**: por `chatwootMessageId` (`payload.id`), NO por SM sid — el mirror ya es UNIQUE por
  `chatwootMessageId` (proposal §B). Ordering esperado: `message_created` (crea la fila) precede a
  `message_updated` (la falla) — pero el orden NO está garantizado (Chatwoot puede entregar fuera
  de orden, o el `message_created` puede demorar).
- **Mecanismo de retry (F4-bis, re-review — CORRIGE una versión previa rota)**: cuando la fila AÚN
  no está espejada (`markDeliveryFailedByChatwootMessageId` devuelve `null`) o el repo tira un error
  transitorio de DB, `handleMessageUpdated` **LANZA** (sin try/catch propio). `execute()` no lo
  ataja → la ruta HTTP hace `catch → next(err) → non-2xx` → Chatwoot (Sidekiq) reintenta la entrega
  con backoff, la ÚNICA señal a la que reacciona (nunca al contenido del body: un 200 con un flag
  interno "no marcar vista" no logra ningún retry). Al lanzar antes del `return`, `execute()`
  tampoco llega a `recordIfNew`: la delivery no queda vista, así que el reintento de Chatwoot
  vuelve a ejecutar este mismo handler — para entonces el `message_created` ya debería haber
  corrido y la fila existe. Simetría exacta con `handleMessageCreated`, que ya dejaba propagar sus
  propios errores de repo (ROB-2) sin necesitar un mecanismo especial. (Una iteración anterior de
  este fix intentó resolverlo con un `boolean` de retorno decidiendo si recordar la delivery —
  no funcionaba: `execute()` es `void` y la ruta responde 200 siempre, así que Chatwoot nunca
  reintentaba y el badge `failed` se perdía en silencio. Se descartó a favor de lanzar.)
- **F4-ter (re-review #2) — la fila-ausente NO es una única clase; exclusión de la clase
  PERMANENTE y tipado de la retriable**: `handleMessageUpdated` deriva la clase del mensaje del
  MISMO payload (`message_type`) con el MISMO helper `mapMessageTypeToDirection` que usa
  `handleMessageCreated` (§7) — nunca duplica el criterio.
  - `direction!==null` (inbound/outbound, 0/1 o `'incoming'`/`'outgoing'`) → TRANSITORIO real: el
    `message_created` de ESE mismo mensaje corrió tarde o fuera de orden. Lanza
    `MessageNotMirroredYetError` (`domain/errors/messaging.ts`, code `MESSAGE_NOT_MIRRORED_YET`),
    mapeado en `errorHandler`'s statusMap a **503** — non-2xx, así que Chatwoot igual reintenta,
    pero YA NO cae en el `[UNHANDLED ERROR]`/`INTERNAL_ERROR` genérico (el errorHandler corta en
    el branch de `DomainError`, `errorHandler.ts:269`, antes de `console.error`/500 genérico de
    `:316`); se loguea `console.warn` (no `.error`) porque es una condición ANTICIPADA, no un
    fallo inesperado.
  - `direction===null` (2/`'activity'`, 3/`'template'`, `message_type` ausente o desconocido) →
    **EXCLUIDA, PERMANENTE**: `handleMessageCreated` JAMÁS persiste una fila para esa clase (§7),
    así que la ausencia nunca se va a resolver reintentando. Antes de F4-ter, esta clase lanzaba
    IGUAL que la transitoria — cada reintento de Chatwoot volvía a pegar el mismo error, un storm
    inútil hasta agotar la retry policy de Sidekiq **sin recuperar nada** (no hay ningún estado
    futuro en el que la fila vaya a aparecer). Ahora es no-op: se loguea `console.warn` una vez
    con el motivo y la delivery se marca vista (200) en el primer intento — misma decisión que ya
    tomó `handleMessageCreated` para ese mensaje.
  - Un repo-error genuino (excepción real de `markDeliveryFailedByChatwootMessageId`, no un
    retorno `null`) sigue siendo un `Error` plano → 500 `[UNHANDLED ERROR]` genérico — no es la
    condición anticipada de arriba, no amerita el tipo 503.
  - **Bound del retry transitorio**: el reintento NO es infinito — está acotado por la retry
    policy de Sidekiq de Chatwoot (reintentos con backoff hasta un tope, fuera del control de
    este repo). Si el `message_created` correspondiente demora más que ese tope, el `failed` se
    pierde igual (riesgo residual documentado, no nuevo — ya existía en F4-bis).
  - **Dependencia con la ventana anti-replay ±5min** (`chatwootSignatureMiddleware`): el mecanismo
    de retry ASUME que Chatwoot re-firma cada reintento con un `X-Chatwoot-Timestamp` FRESCO (no
    reenvía el mismo request firmado original) — el mismo supuesto que ya asume el dedup de
    `conversation_status_changed` (comentario H10/#10 residual en `messaging.routes.ts` ~línea
    181-204: "a request captured within the ±5min anti-replay window can be resent..."). Si
    Chatwoot alguna vez reintentara reenviando el timestamp ORIGINAL sin refirmar, un reintento
    que tarde >5min en llegar moriría con 401 (`INVALID_SIGNATURE`/`STALE_TIMESTAMP`, respondido
    directo por el middleware HMAC, nunca llega a `ReceiveChatwootWebhook`) — el `MessageNotMirroredYetError`
    503 nunca se vería, sería un 401 silencioso. Esto es un SUPUESTO, no algo verificado
    exhaustivamente contra el comportamiento real de reintentos de Sidekiq de Chatwoot — se anota
    como punto a confirmar en el Smoke test del Runbook (paso 5 abajo).
- **Sanitización** (HIST-3): `external_error` es un string corto de Chatwoot (ej. `'Template not found'`,
  o un mensaje con `code` numérico de Twilio como 63016 — catálogo, NO PII), no un payload HTTP crudo.
  `curate` trimea/acota y nunca guarda headers/body crudos.

### CampaignRecipient async-failed — DEFERIDO (documentado)

Con ON el recipient se marca `sent` optimista; un `external_error` posterior marca el **ChatMessage**
`failed` (visible en el hilo) pero NO re-flipea `CampaignRecipient.status` sent→failed (requeriría linkear
`chatwootMessageId`→recipient y el run ya finalizó contadores). Es **paridad con hoy** (hoy el bulk
tampoco async-falla un recipient ya `sent`). Re-marcar el recipient es follow-up (bastaría setear
`campaignRecipientId` en el pre-write ON — D9 — y que `handleMessageUpdated` lo lea; fuera de alcance).

---

## D7 — Gate de aprobación INTACTO + mapeo contentSid → name+language desde `listTemplates` (cero lookup extra)

**El guard `template.approvalStatus === 'approved'` NO se toca** (`SendTemplateMessage.ts:102-106`;
CAMP-2 en el bulk). Sigue leyendo de `templatePort.listTemplates()` → `TwilioContentGateway.listTemplates`
(`TwilioContentGateway.ts:94-116`), es decir el **Twilio Content API directo** vía `TemplateMessagingPort`
(que `TwilioContentGateway` implementa junto con `TemplateAdminPort`). Esto neutraliza Riesgo 5 (el sync
de Chatwoot marca todo `approved` a ciegas): el gate REAL de aprobación se queda en el BE, ANTES de emitir
`template_params.name`.

**El `name`+`language` que Chatwoot necesita YA vienen en el `TemplateDto`** que el guard obtiene —
verificado en `TwilioContentGateway.toTemplateDto` (`:378-388`): `friendlyName = item.friendly_name`,
`language = item.language`. La exploración §5 confirma que el matcher de Chatwoot resuelve por
`friendly_name == template_params['name']` AND `language`. Entonces:

- **Hilo (`SendTemplateMessage`)**: `template.friendlyName`/`template.language` salen del MISMO
  `listTemplates()` del guard 3 — cero lookup adicional.
- **Bulk (`SendCampaign`)**: `Campaign` guarda `templateRef` (sid) + `templateName` + `templateBody`
  (`campaign.ts:69-76`) pero NO `language`. Con ON, `SendCampaign` resuelve el **descriptor** una vez por
  run: `templatePort.listTemplates()` → `find(t => t.contentSid === campaign.templateRef)` →
  `{friendlyName, language, approvalStatus}`. Bonus: re-afirma la aprobación **al send-time** (no solo al
  create). Si el descriptor no existe o no está `approved` con ON → abortar el run
  (`TemplateProviderConfigError`, mismo criterio FIX-2 `:170` — sistémico, no quema recipients).

**Tradeoff aceptado (descriptor cacheado 1×/run)**: el descriptor del bulk se resuelve UNA vez por
run (lazy, `drainQueue`) y se reusa para todo el resto — re-afirma la aprobación al arranque del run,
pero una DES-aprobación a mitad de la corrida NO se re-chequea por recipient. Es una ventana acotada
(dura lo que tarda el run) y coherente con "el flag/estado se lee por batch, no por recipient"
(D4/D8): re-resolver `listTemplates` por destinatario serían 50-100k reads en el hot loop.
**Documentado, NO es un bug.** El hilo (`SendTemplateMessage`, interactivo) SÍ evalúa el gate por
invocación (no cachea).

---

## D8 — Flip del flag a mitad de campaña: resuelto al momento del envío, sin estado por campaña

**El path se decide por lectura del flag al momento del envío** (hilo: 1 lectura/request; bulk: 1
lectura/batch, D4). NO se persiste ninguna decisión de path en `Campaign`/`CampaignRecipient`. Consecuencia
deseada: togglear el flag es un **kill-switch sin deploy** (proposal §C) que afecta los envíos siguientes
al toggle. Una campaña interrumpida y resumida (SEND-6) recomputa el flag en su próxima corrida. Los
recipients ya `sent` no se re-tocan (idempotencia D5; paths mixtos conviven sin colisión). Simple,
sin máquina de estados por campaña.

---

## D9 — `CampaignInboxProjector`: `projectSentMessage` (viejo/OFF) intacto + `projectChatwootTemplateSend` (ON)

`projectSentMessage` (`CampaignInboxProjector.ts:37-39`, phone-keyed, crea `origin:'bulk'` con
`chatwootConversationId:null`, `ChatMessageRepository.ts:71-78`) se **conserva** para el path OFF y para
conversaciones `origin:'bulk'` viejas (proposal Scope OUT §5). La reconciliación Fase 2
(`maybeAdoptBulkConversation`, `ReceiveChatwootWebhook.ts:433`) también se conserva por compat — con ON
queda código muerto para el flujo nuevo (la conversación nace con `chatwootConversationId` real), pero su
deprecación es OUT.

**Método nuevo del port** (DIP: `SendCampaign` no puede tocar `ConversationRepository`/`ChatMessageRepository`
directo — no los tiene inyectados):

```ts
projectChatwootTemplateSend(input: {
  recipient: CampaignRecipient; contactName: string; contactPhone: string;
  chatwootConversationId: number; chatwootMessageId: number; renderedBody: string; sentAt: string;
}): Promise<void>;
```

Impl (`PrismaCampaignInboxProjector`), best-effort/aislada (mismo contrato que `projectSentMessage`):
1. `conversationRepo.upsertByChatwootId({ chatwootConversationId, contactName, contactPhone })`
   (`ConversationRepository.ts:294`) → registro local. Idempotente por la UNIQUE `chatwootConversationId`;
   converge con el `upsertByChatwootId` del eco del webhook.
2. `chatMessageRepo.upsertByChatwootMessageId({ conversationId: local.id, chatwootMessageId,
   direction:'outbound', content: renderedBody, senderName: null, chatwootCreatedAt: sentAt })`
   — presencia inmediata en el inbox + convergencia del eco (D5). (Opcional follow-up: setear
   `campaignRecipientId` acá para habilitar el re-flip async de D6.)
3. `campaignRepo.updateRecipient(recipient.id, { conversationId: local.id })` (`CampaignRepository.ts:122`)
   — preserva el lazo recipient→conversación (etiqueta #1) que el path viejo daba por `projectSentMessage`.

Un fake in-memory del projector cubre ambos métodos en tests.

---

## D10 — Feature flag: migración de siembra (default OFF) + lectura runtime

**Migración de siembra** (patrón verificado `20260917000100_radius_auto_cure_flag/migration.sql`,
`20260905000100_chat_media_download_flag`) — idempotente:

```sql
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('messaging-send-via-chatwoot', false, NOW())
ON CONFLICT DO NOTHING;
```

Sin este seed la UI de feature flags no lo muestra y el operador no puede togglearlo. Va en la MISMA
migración (o hermana) que el delta de `ChatMessage.deliveryStatus/deliveryError` (D6).

**Lectura runtime**: `FeatureFlagRepository.get('messaging-send-via-chatwoot')?.enabled`
(`FeatureFlagRepository.ts:9`), molde `AssignIClassTeam.ts:51`. **Toggle**: desde la UI existente
(`featureFlags.routes.ts` → `SetFeatureFlag`). Default OFF ⇒ deploy sin cambio de comportamiento;
el flip es una acción de operador (§Activación).

---

## D11 — Requirements MODIFIED / deuda de archivado (proposal §E)

Base efectiva = specs de `messaging-bulk` e `inbox-template-send` (implementados, **no archivados** a
`openspec/specs/`). El **spec de este change decide** si archiva primero o emite delta-sobre-delta; el
design recomienda **delta-sobre-delta** (menos fricción, el archivado es deuda separada).

- **`messaging-bulk`**: SEND-2 (el worker invoca el send → ahora branch por flag, D4); SEND-3 (backoff:
  con ON el retry Twilio-facing lo maneja Sidekiq de Chatwoot — se aclara que `sendWithRetry` es solo
  path OFF); SEND-4 (throughput ~80/s: con ON el `RateLimiter` protege a Chatwoot, no a Twilio — Riesgo 2);
  HIST-3 (error curado: con ON viene de `external_error`, D6).
- **`inbox-template-send`**: TS-5 (envío por el port → branch por flag, D3); TS-6 (proyección post-OK →
  con ON reusa `upsertByChatwootMessageId`, D5); MODEL-1/PORT-1 (`providerMessageId`/`upsertTemplateMessage`
  siguen para OFF; `upsertByChatwootMessageId` gana `idempotencyKey` opcional, D5).
- **`messaging-inbox` (F1, archivado)**: SEND-1/2/3 (texto plano por `ChatwootGateway.sendMessage` sin
  template_params) **NO se tocan**.
- **Nuevos requirements**: extensión del `ChatwootGateway` (D2); selección por flag en el use case (D1);
  dedup dual (D5); proyección de `failed` vía `message_updated` (D6). El spec los estructura.

---

## Test plan (Strict TDD — matriz completa en spec/tasks)

- **Fakes in-memory nuevos/extendidos** (test-first, port no adapter):
  - `FakeChatwootGateway` (`__tests__/helpers/FakeChatwootGateway.ts:27`) gana `sendTemplateMessage` +
    `createConversationWithTemplate` con arrays de `*Calls` (molde de `sendMessageCalls:44`), resultados
    configurables e `fail*` flags. Registra `{cid, name, language, processedParams}` para asserts `toEqual`.
  - `InMemoryChatMessageRepository`: `upsertByChatwootMessageId` gana `idempotencyKey` set-once + método
    `markDeliveryFailedByChatwootMessageId`; espejo EXACTO del Prisma (cross-ref).
  - Fake del `CampaignInboxProjector` con `projectChatwootTemplateSend`.
  - `InMemoryFeatureFlagRepository` (ya existe) — setea el flag por test.
- **Tests de seam COMPLETO (lección #28 — use case REAL + repos in-memory, NUNCA mockear el use case)**:
  - `SendTemplateMessage`: flag OFF → llama `templatePort.sendTemplate` + persiste por `providerMessageId`;
    flag ON → llama `chatwootGateway.sendTemplateMessage(cid, …)` + persiste por `chatwootMessageId`;
    guard 0 idempotency funciona en AMBOS; ON con `chatwootConversationId:null` → 422 `CONVERSATION_NOT_LINKED`;
    gate de aprobación intacto en ambos; `bumpLastMessage` nunca toca canReply/status.
  - **Convergencia del eco**: pre-write ON + `upsertByChatwootMessageId` con el MISMO id → UNA fila.
  - `SendCampaign`: flag OFF = comportamiento actual (backcompat, sin deps nuevas); flag ON →
    `createConversationWithTemplate` por recipient + `projectChatwootTemplateSend`; descriptor no-approved
    al send-time → aborta run (`TemplateProviderConfigError`); rate-limiter se llama igual; FIX-5 intacto.
  - `ReceiveChatwootWebhook`: `message_updated` con `external_error` → `deliveryStatus='failed'` linkeado
    por `chatwootMessageId`; sin `external_error` → no-op (200), incluso con fila ausente; CON
    `external_error` y fila ausente de una clase inbound/outbound (o repo-error) → LANZA
    `MessageNotMirroredYetError` (503, retriable, tipado — F4-ter); CON `external_error` y fila
    ausente de una clase activity/template/`message_type` desconocido → no-op PERMANENTE (200,
    vista, cero retry — F4-ter, exclusión); el retry de Chatwoot tras el `message_created` marca
    `failed` + delivery vista (F4-bis/F4-ter).
- **Composition-root assertions** (D1): ambos use cases reciben flag repo + chatwoot gateway; misma
  instancia de gateway que el inbox; mismo key de flag.
- **Rutas** (supertest, repos in-memory): el contrato HTTP no cambia (201/200 dedup, DTO flat) con el
  flag en cualquier estado.
- **E2E vivo al cierre** (memoria `e2e-envelope-mock-mismatch` — los mocks no cazan mismatches de shape):
  1 template desde el hilo + 1 bulk chico contra el Chatwoot real de `.37`, con el sync ya corrido.

---

## Runbook de activación (parte es infra fuera del repo — proposal §7)

1. **Deploy**: migración que siembra `messaging-send-via-chatwoot` (OFF) + columnas
   `ChatMessage.deliveryStatus/deliveryError`. Wiring de AMBOS canales (D1). El comportamiento NO cambia
   (flag OFF).
2. **Webhook `message_updated`** (D2.c/D6): re-correr `scripts/registerChatwootWebhook.ts` (o agregar la
   subscription en la UI de Chatwoot) para que `message_updated` llegue a `/api/messaging/webhook`
   (HMAC-gated, `messaging.routes.ts`). Sin esto, `failed` async no aflora.
3. **Cron de sync (host del VPS, fuera del repo)** — decisión A de la proposal:
   `docker exec <chatwoot> bundle exec rails runner "Channels::Twilio::TemplatesSyncJob.perform_now(1)"`
   cada 15 min (channel_id=1 = `Channel::TwilioSms`, verificado exploración §5; los templates cambian
   rara vez). Reusa el código de sync propio de Chatwoot (mínima fragilidad).
4. **Sync inicial + verificación**: correr el sync UNA vez manual y verificar (read-only `rails runner`)
   que `channel.content_templates` contiene los templates REALES de negocio, no los 5 de muestra
   (`content_templates.templates.size` > 5 y con los friendly_names reales). **BLOQUEANTE** (Riesgo 1):
   sin esto todo template real → `external_error:'Template not found'`.
5. **Smoke test con flag ON (1 conversación)**: flip ON → enviar template desde el hilo → confirmar que
   (a) aparece en el hilo de Chatwoot; (b) el mirror upsertea por `chatwootMessageId`; (c) un template
   deliberadamente inválido aflora `deliveryStatus='failed'` vía `message_updated`; (d) **supuesto
   verificable (F4-ter)** — si el escenario transitorio (fila-ausente) se puede forzar (ej. delay
   artificial del `message_created`), confirmar que el reintento de Chatwoot llega con un
   `X-Chatwoot-Timestamp` FRESCO (no el original re-enviado) — si el reintento pasa la ventana
   ±5min y Chatwoot lo re-firma, `chatwootSignatureMiddleware` lo deja pasar (200/503 según
   corresponda); si NO re-firma, un reintento tardío moriría 401 antes de llegar al use case,
   silenciosamente. No bloqueante para el rollout (best-effort), pero documentar el resultado.
6. **Flip gradual**: ON para send-desde-hilo primero; luego un **bulk chico** (5-10 destinatarios) y
   verificar el hilo + `recipient.conversationId` + la cola Sidekiq de Chatwoot (Riesgo 2, throughput).
7. **Rollback**: togglear el flag **OFF** → revierte a Twilio-directo al instante, **sin deploy**.
   Criterio de rollback: `external_error` masivo (sync roto), cola Sidekiq desbordada, o cualquier
   anomalía de entrega.

---

## Riesgos residuales del diseño

1. **Sync stale (BLOQUEANTE hasta §Activación 3-4)** — mitigado por flag OFF + gate de aprobación en el BE (D7).
2. **Throughput** — `RateLimiter` pasa a proteger a Chatwoot, no a Twilio (D4/Riesgo 2 proposal). Monitoreo de Sidekiq.
3. **`chatwootMessageId` no capturado en el create bulk** — degradación: el eco pobla el mirror igual (D2.b).
4. **CampaignRecipient async-failed** deferido (D6) — paridad con hoy, no regresión.
5. **Doble-path cableado** durante el rollout (D1/Riesgo 7 proposal) — transitorio, se limpia al consolidar.
