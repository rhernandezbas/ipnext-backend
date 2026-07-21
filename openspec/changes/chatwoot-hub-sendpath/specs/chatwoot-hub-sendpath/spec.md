# Spec — chatwoot-hub-sendpath (delta)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify). Delta-sobre-delta:
`messaging-bulk` e `inbox-template-send` NO están archivados en `openspec/specs/` todavía — este
delta modifica sus specs en `openspec/changes/`, no `openspec/specs/`.

---

## Capability: envío vía Chatwoot (NUEVA)

### Requirement: CHW-1 — `ChatwootGateway.sendTemplate` sobre conversación existente

El port `ChatwootGateway` MUST ganar `sendTemplate(chatwootConversationId, {name, language,
processedParams}): Promise<ChatwootMessageDto>`. `HttpChatwootGateway` MUST hacer
`POST /conversations/:id/messages` con `template_params:{name, language, processed_params}`
(`processedParams` mapeado 1:1 sin transformación, verificado). Cualquier falla HTTP MUST lanzar
`ChatwootUnavailableError` (existente, CHW-7).

#### Scenario: envío sobre conversación ya existente
- Given una conversación con `chatwootConversationId` real
- When se invoca `sendTemplate(id, {name:'deuda_v1', language:'es', processedParams:{'1':'Juan'}})`
- Then el POST lleva `template_params` con esa forma exacta y devuelve el `ChatwootMessageDto` con `id`

### Requirement: CHW-2 — `ChatwootGateway.createConversationWithTemplate` (find-or-create, bulk)

El port MUST ganar `createConversationWithTemplate({phoneE164, name, language, processedParams}):
Promise<{chatwootConversationId, message: ChatwootMessageDto}>`. MUST resolver en UNA llamada
(`POST /conversations`, `source_id:"whatsapp:"+phoneE164`) el find-or-create de contacto + create
de conversación + primer mensaje con `template_params` (atómico, verificado). El adapter MUST
apoyarse ÚNICAMENTE en el find-or-create atómico de Chatwoot por `source_id` EXACTO — MUST NOT
implementar una búsqueda propia de contacto por teléfono difusa antes de este POST.

#### Scenario: primer envío del recipient (sin conversación Chatwoot previa)
- Given un `CampaignRecipient` sin `chatwootConversationId`
- When se invoca `createConversationWithTemplate(...)`
- Then contacto+conversación+mensaje se crean en una llamada; el resultado trae
  `chatwootConversationId` + `message.id` para persistir (CHW-4)

#### Scenario: teléfono con contacto ya existente (mismo source_id) — reuse, no duplica
- Given un `Client` cuyo `source_id` (`whatsapp:+E164`) YA tiene un `Contact` en Chatwoot
- When se invoca `createConversationWithTemplate` para ese teléfono
- Then Chatwoot reusa el `Contact` existente (find-or-create por `source_id` exacto); el adapter
  MUST NOT crear un segundo `Contact` ni intentar desambiguar por búsqueda propia

### Requirement: CHW-3 — selección de adapter por feature flag `messaging-send-via-chatwoot`

`SendTemplateMessage` y `SendCampaign` MUST resolver el `TemplateMessagingPort` activo leyendo el
flag `messaging-send-via-chatwoot` (`FeatureFlagRepository.get`) POR INVOCACIÓN/por-recipient (no
cacheado al boot). OFF → `TwilioContentGateway`, comportamiento BYTE-IDÉNTICO a hoy. ON → adapter
Chatwoot (CHW-1/CHW-2). El use case NUNCA conoce cuál gana.

#### Scenario: flag OFF — byte-idéntico
- Given flag OFF
- When `execute`/worker corre
- Then la llamada al proveedor, errores y persistencia son IDÉNTICOS al comportamiento pre-change

#### Scenario: flag flip a mitad de campaña — split de paths, sin duplicar ni corromper
- Given una campaña con 5 recipients; los primeros 2 se procesan con flag OFF (persisten
  `providerMessageId`) y el operador togglea ON antes de procesar el 3ro
- When el worker continúa
- Then recipients 3-5 se procesan vía Chatwoot (persisten `chatwootMessageId`);
  `Campaign.sentCount` llega a 5 igual (SEND-7); NINGÚN recipient se reprocesa (SEND-6 sostiene la
  resumibilidad a través del split)

### Requirement: CHW-4 — dedup por `chatwootMessageId` (reuso del mecanismo del webhook)

Bajo flag ON, el `id` devuelto por CHW-1/CHW-2 MUST capturarse y persistirse vía
`messageRepo.upsertByChatwootMessageId({chatwootMessageId:id, ...})` — el MISMO método que
`ReceiveChatwootWebhook` usa para el eco `message_created`. Esto MUST reemplazar
`upsertTemplateMessage` (one-off) y el flujo de proyección por-teléfono (bulk) para el path
Chatwoot.

#### Scenario: eco del webhook converge sin duplicar (race)
- Given el envío captura `chatwootMessageId:555` y el webhook `message_created` con `id:555` llega
  ANTES de que la respuesta del POST vuelva al backend
- When ambos caminos llaman `upsertByChatwootMessageId({chatwootMessageId:555,...})`
- Then existe UNA sola fila para 555 (el orden de llegada no importa)

#### Scenario: retry con idempotencyKey bajo flag ON (guard 0 sin cambios)
- Given un POST previo exitoso con `idempotencyKey:'k1'` bajo flag ON
- When se reenvía el MISMO POST con la MISMA key
- Then el GUARD 0 existente (`findByIdempotencyKey`, no modificado por este change) intercepta
  ANTES de tocar el port — CERO llamada nueva a Chatwoot, CERO conversación/mensaje nuevo, devuelve
  `deduped:true`

### Requirement: CHW-5 — `failed` vía `message_updated`/`external_error`, linkeado por `chatwootMessageId`

`ReceiveChatwootWebhook` MUST detectar `message_updated` con `content_attributes.external_error`
poblado, resolver el mirror por `chatwootMessageId` (ya persistido, CHW-4) y proyectar un estado
equivalente a `failed` con error saneado (extiende HIST-3 modified). `delivered`/`read` siguen
INVISIBLES (paridad con hoy, Decisión B — no regresión).

#### Scenario: template no sincronizado en Chatwoot (sync stale/no corrió)
- Given un template real que NO está en `channel.content_templates` de Chatwoot (job de sync
  manual sin correr, riesgo #1 proposal) y flag ON
- When se envía (Chatwoot responde 201 igual, optimista) y luego llega `message_updated` con
  `external_error:'Template not found'`
- Then el mirror para ese `chatwootMessageId` queda `failed` con error saneado — el request
  original YA había devuelto 201/deduped, sin romperse

#### Scenario: `message_updated` sin `external_error` (delivered/read)
- Given un `message_updated` sin cambio detectable en `external_error`
- When llega el webhook
- Then el mirror NO cambia de status (delivered/read siguen sin ser observables)

### Requirement: CHW-6 — el gate de aprobación real es NUESTRO, no de Chatwoot

TPL-2/CAMP-2/TS-3 (existentes, SIN modificar) MUST seguir siendo la ÚNICA fuente de verdad de
`approvalStatus==='approved'` (vía `TemplateAdminPort` contra Twilio Content API directo),
evaluados ANTES de resolver `template_params.name`, sin importar el flag. `derive_status` de
Chatwoot (siempre `'approved'` a ciegas) MUST NUNCA usarse como gate.

#### Scenario: template no aprobado en nuestro gate — cero llamada a Chatwoot
- Given un template `pending` según `TemplateAdminPort`
- When se intenta enviar bajo flag ON
- Then TPL-2/TS-3 rechaza ANTES de construir `template_params.name` — CERO POST a Chatwoot

> Nota (tradeoff aceptado, D7): en el BULK (`SendCampaign`), el descriptor del template
> (`{friendlyName, language, approvalStatus}`) se resuelve UNA vez por RUN (lazy, cacheado) — re-afirma
> la aprobación al send-time, pero una DES-aprobación a mitad de la corrida NO se re-chequea por
> recipient. Es una ventana acotada (dura lo que tarda un run) y consistente con "el flag/estado se
> lee por batch, no por recipient" (D4/D8): re-resolver el gate por destinatario serían 50-100k
> `listTemplates` en el hot loop. Documentado, NO es un bug. En el HILO (`SendTemplateMessage`,
> interactivo) el gate SÍ corre por invocación (no cachea).

### Requirement: CHW-7 — `ChatwootUnavailableError` en falla de Chatwoot, sin persistencia

El adapter Chatwoot (CHW-1/CHW-2) MUST lanzar `ChatwootUnavailableError` (existente en
`domain/errors/messaging.ts`, mismo error de `ChatwootGateway.sendMessage`/`setStatus`) ante
CUALQUIER falla de red/timeout/4xx-5xx — NUNCA `TemplateProviderUnavailableError` (reservado al
path Twilio-directo). En falla, MUST NOT persistirse nada (mismo guard-order que hoy).

#### Scenario: Chatwoot caído — one-off
- Given Chatwoot inalcanzable (timeout) y flag ON
- When `SendTemplateMessage.execute(...)`
- Then lanza `ChatwootUnavailableError` (→503); el mirror queda EXACTAMENTE como estaba

#### Scenario: Chatwoot caído — bulk, no aborta el batch
- Given Chatwoot caído durante el worker de `SendCampaign`
- When procesa UN recipient
- Then ESE recipient termina `failed` con el error saneado; el resto sigue procesándose

---

## MODIFIED Requirements — messaging-bulk

### Requirement: SEND-2 — envío por destinatario con status resultante (adapter por flag)

Por cada `CampaignRecipient` en `queued`, el worker MUST invocar
`TemplateMessagingPort.sendTemplate(phone, templateRef, variables)` sin saber qué adapter resuelve
la llamada (flag `messaging-send-via-chatwoot`, CHW-3). OFF: comportamiento BYTE-IDÉNTICO a hoy
(Twilio directo, `status:'sent'` confirma aceptación real). ON: el adapter Chatwoot resuelve vía
`createConversationWithTemplate` (CHW-2, sin `chatwootConversationId` previo) o `sendTemplate`
(CHW-1); `status:'sent'` pasa a ser OPTIMISTA (Chatwoot aceptó el POST, no confirma entrega real —
el fallo real llega async, CHW-5). Falla → `status:'failed'` + `error`; un fallo por-destinatario
MUST NOT abortar el batch.
(Previously: adapter SIEMPRE Twilio directo, `status:'sent'` confirmaba envío real.)

#### Scenario: batch con éxitos y un fallo aislado (comportamiento observable sin cambios)
- Given 3 recipients `queued`; el adapter activo responde OK para 2 y error persistente para 1
- When corre el worker
- Then 2 `sent`, 1 `failed`; la campaña queda `done`

#### Scenario: primer envío bajo flag ON (sin conversación Chatwoot previa)
- Given flag ON y un recipient sin `chatwootConversationId`
- When el worker invoca `sendTemplate`
- Then dispara `createConversationWithTemplate` (CHW-2) y persiste `chatwootConversationId` +
  `chatwootMessageId` (CHW-4)

### Requirement: SEND-3 — reintentos por-destinatario con backoff 429-aware SÓLO en el path OFF (Twilio directo)

Bajo flag OFF, el worker MUST reintentar 2-3 veces ante errores retryables (`RETRYABLE_STATUS`,
backoff exponencial + jitter, `sendWithRetry`) contra la API de Twilio directo; no-retryables fallan
de inmediato. Bajo flag ON, `sendWithRetry` NO aplica (D4): una falla transitoria de Chatwoot marca
el recipient `failed` INMEDIATAMENTE, sin retry local — el POST hacia Chatwoot es un handshake, no el
envío final; el reintento del envío REAL a Twilio lo maneja la cola Sidekiq de Chatwoot, y un fallo
real posterior aflora async vía CHW-5. Un fallo por-destinatario (cualquier path) MUST NOT abortar el
batch.
(Previously: retry SIEMPRE contra la API de Twilio directo. La primera pasada de este delta decía
—erróneamente— que el retry también corría contra Chatwoot bajo ON; se corrige acá para alinear con
D4/D11: bajo ON no hay retry local, es Sidekiq de Chatwoot quien reintenta el envío real.)

#### Scenario: falla transitoria de Chatwoot bajo ON → recipient `failed` inmediato (sin retry local)
- Given flag ON y Chatwoot responde 503 al POST de `createConversationWithTemplate`
- When el worker procesa ese recipient
- Then el recipient termina `failed` INMEDIATAMENTE (sin `sendWithRetry`); el batch sigue; el
  reintento del envío real lo hace la cola Sidekiq de Chatwoot, NO este loop (D4)

#### Scenario: falla transitoria de Twilio y luego éxito (flag OFF, sin cambios)
- Given flag OFF, Twilio responde 503 dos veces y OK en el 3er intento
- When el worker procesa ese recipient
- Then termina `sent` (reintentos transparentes vía `sendWithRetry`)

### Requirement: SEND-4 — rate-limit proactivo (~80 msg/s) sobre el adapter activo

El worker MUST throttlear contra el limiter inyectado ANTES de invocar `sendTemplate`, sin importar
el flag. OFF: protege el throughput real hacia Twilio (sin cambios). ON: el limiter protege los
POST hacia CHATWOOT — el envío real a Twilio es async en la cola Sidekiq de Chatwoot, FUERA del
alcance de este limiter (riesgo aceptado, proposal Risk 2).
(Previously: el limiter protegía directamente el throughput hacia Twilio.)

#### Scenario: el worker consulta el limiter antes de cada envío (contrato sin cambios)
- Given un limiter inyectado (máx 2/tick) y 5 recipients `queued`
- When corre el worker
- Then el limiter se consulta 5 veces antes de cada `sendTemplate`, sin importar el adapter activo

### Requirement: HIST-3 — DTO curado, sin datos sensibles del proveedor activo

El detalle por-destinatario MUST NUNCA exponer el payload/response crudo del proveedor activo
(Twilio u Chatwoot, según flag) ni credenciales — solo un `error` saneado cuando `status:'failed'`.
Bajo ON, el error puede originarse en `content_attributes.external_error` de Chatwoot en vez de la
respuesta HTTP de Twilio; el saneo aplica igual.
(Previously: el error siempre venía de la respuesta HTTP directa de Twilio.)

#### Scenario: recipient fallido con error de Chatwoot (flag ON)
- Given un recipient `failed` cuyo error interno viene de `external_error` de Chatwoot
- When se pide el detalle de la campaña
- Then el DTO expone SOLO un mensaje saneado, nunca headers/tokens de Chatwoot

---

## MODIFIED Requirements — inbox-template-send (BE)

### Requirement: TS-5 — envío por el port, errores tipados propagan, SIN retry interno

El envío MUST ser `templatePort.sendTemplate(phoneE164, templateRef, variables)` SIN
`sendWithRetry` (D6), sin importar el flag. OFF: `TemplateSendRejectedError` /
`TemplateProviderUnavailableError` / `TemplateProviderConfigError` (sin cambios). ON: el adapter
Chatwoot lanza `ChatwootUnavailableError` (CHW-7) ante falla HTTP — propaga igual (→503). En AMBOS
casos, falla MUST NOT persistir nada. Éxito bajo ON es OPTIMISTA; un fallo real posterior de Twilio
llega async y no es parte del retorno síncrono de `execute` (CHW-5).
(Previously: únicos errores tipados eran los tres de Twilio directo.)

#### Scenario: Twilio rechaza (flag OFF, sin cambios)
- Given el fake lanza `TemplateSendRejectedError`
- When `execute(...)`
- Then el error propaga y el mirror queda intacto

#### Scenario: Chatwoot caído (flag ON)
- Given el adapter Chatwoot lanza `ChatwootUnavailableError`
- When `execute(...)`
- Then el error propaga (→503) y el mirror queda EXACTAMENTE como estaba

### Requirement: TS-6 — proyección al hilo + bump post-OK (dedup por chatwootMessageId bajo flag ON)

Tras el envío aceptado: (a) `renderTemplateBody`; (b) proyección — OFF: `upsertTemplateMessage` con
`providerMessageId=result.providerId` (sin cambios, MODEL-1/PORT-1 legacy); ON:
`messageRepo.upsertByChatwootMessageId({chatwootMessageId:<id de Chatwoot>, conversationId,
direction:'outbound', content, senderName, chatwootCreatedAt:sentAt})` — MISMO método que el
webhook, para que el eco `message_created` converja sin duplicar (CHW-4); (c) `bumpLastMessage` sin
cambios; (d) devolver `toChatMessageDto`.
> Nota de spec: el valor exacto de `origin` para las filas proyectadas bajo flag ON no está fijado
> por el proposal — abierto a `sdd-design`.
(Previously: SIEMPRE `upsertTemplateMessage` con `providerMessageId`.)

#### Scenario: happy path flag ON — dedup por chatwootMessageId
- Given flag ON, template aprobado, Chatwoot acepta con `id:555`
- When `execute(...)` completa
- Then persiste vía `upsertByChatwootMessageId({chatwootMessageId:555,...})`, NO vía
  `upsertTemplateMessage`

#### Scenario: retry con idempotencyKey bajo flag ON (guard 0 sin cambios)
- Given un POST previo exitoso con `idempotencyKey:'k1'` bajo flag ON
- When se reenvía el MISMO POST con la MISMA key
- Then el GUARD 0 (`findByIdempotencyKey`, no modificado) intercepta ANTES del port — CERO llamada
  nueva a Chatwoot, devuelve `deduped:true`

#### Scenario: el envío NO abre la ventana (sin cambios, D2)
- Given `canReply:false`
- When el happy path completa (cualquier flag)
- Then `canReply` sigue `false`

### Requirement: MODEL-1 — `ChatMessage.providerMessageId` pasa a EXCLUSIVO del path Twilio-directo

Sin cambios de schema en este delta; `providerMessageId String? @unique` (ya existente) pasa a
poblarse SOLO cuando el flag está OFF. Bajo ON, las filas nuevas dejan `providerMessageId:NULL` y
usan `chatwootMessageId` (ya existente) como clave de idempotencia (PORT-1 modified, CHW-4). Ambas
columnas `@unique` nullable conviven sin conflicto.
(Previously: `providerMessageId` era la ÚNICA clave de idempotencia del path one-off/bulk-template.)

#### Scenario: filas de ambos paths conviven en el mismo hilo
- Given filas viejas (OFF, `providerMessageId` poblado) y nuevas (ON, `chatwootMessageId` poblado)
- When se listan en el mismo hilo
- Then conviven sin error de unicidad, ordenadas por `chatwootCreatedAt`

### Requirement: PORT-1 — `upsertTemplateMessage` pasa a EXCLUSIVO del path Twilio-directo (flag OFF)

El port `upsertTemplateMessage(input)` sigue existiendo sin cambios de firma/semántica — MUST
invocarse SOLO cuando el flag está OFF (byte-idéntico a hoy). Bajo ON, `SendTemplateMessage`/
`SendCampaign` MUST invocar `messageRepo.upsertByChatwootMessageId` EN VEZ de `upsertTemplateMessage`
(TS-6/SEND-2 modified, CHW-4).
(Previously: `upsertTemplateMessage` era el ÚNICO camino de persistencia para envíos one-off.)

#### Scenario: upsert idempotente por providerMessageId (flag OFF, sin cambios)
- Given un `upsertTemplateMessage` ya ejecutado con `providerMessageId:'SM123'`
- When se re-ejecuta con el mismo `providerMessageId`
- Then sigue habiendo UNA sola fila para `SM123`

#### Scenario: bajo flag ON, `upsertTemplateMessage` MUST NOT invocarse
- Given flag ON
- When `SendTemplateMessage.execute` completa un envío
- Then la persistencia pasa por `upsertByChatwootMessageId`, CERO llamada a `upsertTemplateMessage`
