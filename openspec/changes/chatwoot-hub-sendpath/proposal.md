# Proposal — chatwoot-hub-sendpath (Chatwoot = eje central; TODO saliente vía Chatwoot)

## 1. Why / Intent

Decisión del usuario (2026-07-21): **Chatwoot pasa a ser el EJE CENTRAL de la mensajería**. TODO
mensaje saliente por template — el que se manda desde el hilo del inbox (`SendTemplateMessage`) y el
masivo/campañas (`SendCampaign`) — deja de ir **Twilio-directo** (`TwilioContentGateway.sendTemplate`,
POST a `api.twilio.com/.../Messages.json` con `ContentSid`) y pasa a enviarse **VÍA la API de
Chatwoot** (`POST /api/v1/accounts/{id}/conversations/{cid}/messages` con `template_params`). Prominense
deja de ser "centro de datos" de mensajería → queda como **orquestador de campañas + front**; su mirror
local `Conversation`/`ChatMessage` pasa a ser **cache de lectura**.

Esto **REVIERTE** el "send-path LOCKED = Twilio directo" fijado el 2026-07-14 (specs de `messaging-bulk`
y `inbox-template-send`). El porqué del flip: (1) **hoy los salientes Twilio-directo NO se registran en
Chatwoot** — el agente no ve en el hilo lo que se mandó, rompiendo el modelo omnicanal; (2) verificado
en vivo (container Chatwoot v4.13.0, `SendOnTwilioService`/`TemplateProcessorService`/`MessageBuilder`)
que el canal Twilio de Chatwoot **soporta templates nativo** — cuando se decidió el lock a Twilio-directo
esto no estaba verificado; hoy sí.

Este change es **BE-first, sin FE** (ver §6 Decisión D — el contrato HTTP que consume el FE queda
INTACTO). Se apoya en la exploración `sdd/chatwoot-hub-sendpath/explore` (mapa técnico completo, payloads
verificados en vivo) y en la decisión `sdd/chatwoot-hub-sendpath/decision`.

## 2. Scope IN

1. **Flip del send-path de templates a Chatwoot**, gobernado por **feature flag** (§6.C). Con el flag ON,
   `SendTemplateMessage` y `SendCampaign` envían por Chatwoot; con el flag OFF, siguen por Twilio-directo
   (fallback inmediato, sin deploy).
2. **Extender el `ChatwootGateway`** (port + `HttpChatwootGateway`) con lo que falta para el flip:
   - envío de mensaje con `template_params` (`{name:<friendly_name>, language, processed_params:{"1":...}}`)
     sobre una conversación existente (path del hilo);
   - find-or-create de contacto + create de conversación con primer mensaje `template_params` en UNA
     llamada (`POST /conversations`, `source_id = whatsapp:+E164`) para el bulk.
3. **Adapter Chatwoot del `TemplateMessagingPort`** (mismo port ISP que hoy implementa `TwilioContentGateway`)
   — el seam hexagonal que hace que el flip sea un **swap de adapter**, no un rediseño de los use cases.
4. **Dedup por `chatwootMessageId`**: capturar el `id` de la respuesta del POST y persistir con el MISMO
   `upsertByChatwootMessageId` que ya usa el webhook — el eco `message_created` posterior converge en un
   upsert idéntico (UNIQUE), sin duplicar (verificado, §exploración 4).
5. **Estados de entrega degradados a paridad-con-hoy** (§6.B): `failed`/`undelivered` detectable vía el
   webhook `message_updated` (`content_attributes.external_error`); `delivered`/`read` fuera de alcance
   (igual que hoy — el BE no trackea entrega).
6. **Feature flag + migración de siembra** (default OFF, patrón del repo) + **runbook de activación**
   (§7) que documenta el paso de infra fuera del repo (sync de templates de Chatwoot).

## 3. Scope OUT (anti scope-creep)

- **FE**: ningún cambio. El contrato HTTP (rutas/DTOs) queda intacto (§6.D). El FE se entera del flip solo
  porque ahora el saliente aparece en el hilo Chatwoot — es una mejora observable, no un cambio de contrato.
- **`TemplateAdminPort`** (CRUD de templates: create/get/delete/submitForApproval) **NO se toca** — sigue
  yendo directo al Twilio Content API. Chatwoot no tiene API de creación/aprobación de templates, y además
  su sync marca todo `approved` a ciegas (§Riesgo 5) — el gate real de aprobación se queda en el BE.
- **Delivered/read reales** (status callback granular) → fuera. Hoy tampoco existen (no hay ruta de
  status-callback en el BE) — no es regresión.
- **Meta Cloud API directo / WABA propio** (Opción C de la decisión) → futuro estratégico, no-bloqueante.
- **Reescribir el flujo de reconciliación bulk→inbox viejo** (`CampaignInboxProjector`,
  `maybeAdoptBulkConversation`): se conserva por compat con conversaciones `origin:'bulk'` viejas; el nuevo
  flujo no lo usa (la conversación Chatwoot nace con `chatwootConversationId` real). Su deprecación es OUT.

## 4. Evidencia técnica (verificada en vivo — resumen)

| Hecho | Fuente |
|---|---|
| Payload de template por Chatwoot resuelve por **NOMBRE+idioma** (no `content_sid`) contra `channel.content_templates` | `Twilio::TemplateProcessorService#find_template` (verificado) |
| El sync de `channel.content_templates` (`TemplatesSyncJob`) **NO tiene cron ni endpoint HTTP** — solo `rails runner`; el inbox 1 tiene 5 templates de MUESTRA (10 días stale), NINGUNO real | verificado en vivo (`rails runner`, read-only) |
| `Message#webhook_data` **NO incluye `status`** → `message_updated` solo detecta **failed** (via `content_attributes.external_error`); delivered/read invisibles | `app/models/message.rb`, verificado |
| Chatwoot pisa el `status_callback` per-mensaje apuntándolo a SU propio endpoint (no al del BE) | `SendOnTwilioService#send_template_message`, verificado |
| El POST devuelve 201 ANTES del envío real (async `SendReplyJob`/Sidekiq) — 201 ≠ Twilio-aceptado | verificado |
| El eco del webhook trae el `id` (chatwootMessageId) → dedup reusable por `upsertByChatwootMessageId` | `message_builder.rb`, `ReceiveChatwootWebhook`, verificado |
| Bulk en 1-2 calls: `POST /conversations` crea contacto+conversación+primer mensaje con `template_params` atómico; token `ronald` (administrator) alcanza | `ConversationsController#create`, `ContactInboxBuilder`, verificado |

## 5. Approach / Arquitectura (hexagonal)

**El seam es el `TemplateMessagingPort`** (ya existe, `domain/ports/TemplateMessagingPort.ts`). Hoy lo
implementa `TwilioContentGateway`. Este change agrega un **segundo adapter** (Chatwoot) que implementa el
MISMO port, y una **selección por feature flag** en composición (o un adapter compuesto/router que lee el
flag por request). Los use cases (`SendTemplateMessage`, `SendCampaign`) siguen dependiendo SOLO del port
— no se enteran de cuál gana. Es la jugada hexagonal limpia: la decisión queda encapsulada en un adapter
reemplazable, sin filtrarse al núcleo (mismo argumento que fundó el port en `messaging-bulk`).

- **Port `ChatwootGateway`** (`domain/ports/ChatwootGateway.ts`) — extender con: `sendTemplate(conversationId, {name, language, processedParams})` sobre conversación existente, y
  `createConversationWithTemplate({phoneE164, name, language, processedParams})` (find-or-create contacto +
  create conversación + primer mensaje) para el bulk. `HttpChatwootGateway` implementa ambos.
- **Adapter `TemplateMessagingPort` (Chatwoot)** — traduce el `Record<string,string>` de variables ya
  resuelto a `processed_params` (mapea 1:1, cero transformación) y el `templateRef` al `friendly_name`
  (§Riesgo 5: el `name` sale del catálogo ya gateado por aprobación real vía `TemplateAdminPort`).
- **Persistencia**: reusar `messageRepo.upsertByChatwootMessageId({chatwootMessageId: dto.id, ...})` en vez
  de `upsertTemplateMessage`/`providerMessageId` (que quedan opcionales/obsoletos para el nuevo path — MODEL-1/PORT-1 de `inbox-template-send`).
- **Feature flag** — migración de siembra `INSERT INTO "FeatureFlag" VALUES ('messaging-send-via-chatwoot', false, NOW()) ON CONFLICT DO NOTHING` (patrón verificado: `20260905000100_chat_media_download_flag`,
  `20260917000100_radius_auto_cure_flag`). Se lee en runtime vía `FeatureFlagRepository.get(...)`;
  se togglea desde la UI de feature flags existente (`featureFlags.routes.ts`).

## 6. Decisiones (A–E) con tradeoffs

### A. Sync de templates de Chatwoot — **cron en el HOST del VPS (`docker exec ... rails runner`)**

**Elegido (opción a).** Un cron en el host del VPS que corre
`docker exec <chatwoot> bundle exec rails runner "Channels::Twilio::TemplatesSyncJob.perform_now(<channel_id>)"`
cada N minutos, para mantener `channel.content_templates` fresco con los templates reales de negocio.

- **Por qué**: reusa el **código de sync propio de Chatwoot** (el que su `TemplateProcessorService` espera
  como fuente de verdad) → mínima fragilidad. Cero acoplamiento del BE a SSH/DB internos.
- **Descartado (b) BE dispara por SSH**: acopla el BE a shell/credenciales del VPS, superficie de seguridad,
  frágil. (c) **escribir el jsonb `content_templates` directo desde el BE**: replicaría la lógica de
  `TemplateSyncService`, se acopla al shape interno de Chatwoot (cambia entre versiones), y el BE habla HTTP,
  no tiene la DB de Chatwoot a mano. Rechazadas.
- **Tradeoff aceptado**: es **infra fuera del repo** → paso de activación documentado (§7) y **concern de
  monitoreo**: si el cron muere, un template nuevo/renombrado falla silencioso con `external_error:'Template
  not found'`. **Mitigación**: (1) el flag OFF (Twilio-directo) cubre la ventana; (2) el fallo es observable
  vía `failed`/`external_error`; (3) el gate de aprobación real sigue en el BE (no dependemos del sync para
  saber si un template está aprobado).

### B. Estados de entrega — **paridad con hoy: sent/failed, delivered/read fuera (tradeoff explícito)**

- **`failed`/`undelivered`**: detectable vía `message_updated` (`content_attributes.external_error`) →
  proyectar a `failed` + DTO de error curado. **Linkeo**: por `chatwootMessageId` (el webhook trae el `id`),
  NO por SM sid — no hace falta el sid para matchear el mirror (ya es UNIQUE por `chatwootMessageId`).
- **`sent`**: implícito (mensaje registrado en Chatwoot); NO confirma envío Twilio (async). Se registra
  optimista.
- **`delivered`/`read`**: **INVISIBLES** vía webhook (payload indistinguible). **Tradeoff ACEPTADO** — y
  **no es regresión**: hoy el BE **no tiene ruta de status-callback** (verificado), y el MS `MG46...` tiene su
  callback **pisado por Chatwoot** hacia el endpoint de Chatwoot per-mensaje → aunque construyéramos una ruta
  de callback en el BE, NO recibiría los callbacks de los mensajes que manda Chatwoot. `messaging-bulk` ya
  difería delivered/read a F3 e `inbox-template-send` los tenía OUT.
- **Mitigación futura (deferida)**: poll a `GET /conversations/:id/messages` por la columna `status`
  (sin verificar si el GET la expone) — no en este change.

### C. Rollout — **feature flag `messaging-send-via-chatwoot` (default OFF), Twilio-directo como fallback**

**Sí, feature flag.** Patrón del repo: seed por migración default OFF, lectura en runtime, toggle desde la
UI. Con flag OFF → path actual `TwilioContentGateway` (probado en prod). Con flag ON → adapter Chatwoot.
El MISMO flag gobierna `SendTemplateMessage` **y** `SendCampaign` (flip coherente).

- **Por qué**: fallback **inmediato sin deploy** (togglear OFF revierte al instante), rollout gradual
  (smoke test con 1 conversación antes del bulk), y aísla el riesgo del sync stale (§A) y del throughput (§Riesgo 2).
- **Tradeoff**: ambos adapters conviven cableados durante el rollout (doble path temporal) — aceptable y
  transitorio; se limpia el Twilio-directo cuando el flip se consolide (change futuro).

### D. Scope FE — **contrato HTTP INTACTO, cero cambios de FE (verificado contra las rutas)**

Verificado contra `messaging.routes.ts` y `messagingBulk.routes.ts`:
- `POST /api/messaging/conversations/:id/send-template` `{templateRef, variables, idempotencyKey?}` →
  devuelve `ChatMessageDto` (201 nuevo / 200 deduped). **Shape sin cambios** — el use case sigue devolviendo
  el DTO del mirror.
- `GET /api/messaging/send-templates` → `{data}`. Sin cambios.
- Bulk (`/api/messaging/bulk/*`): create/preview/send/get/list campañas — el flip cambia el **send-path
  interno**, NO request/response.
- **Declaración**: FE **no requiere cambios** para el flip.
- **Matiz de comportamiento (no de contrato)**: hoy algunos errores de envío llegan **síncronos** (422/503
  tipados, porque el call Twilio-directo es sync y el adapter mapea el error). Bajo Chatwoot-send el POST
  devuelve **201 igual** y el fallo real (Twilio) llega **async** vía `message_updated` → el mensaje del hilo
  vira a `failed`. El endpoint **sigue devolviendo `ChatMessageDto`** (contrato intacto); el composer ya
  poललea/renderiza el hilo, así que el `failed` aflora por el mirror. Se declara como shift de timing de
  UX aceptado, sin cambio de DTO.

### E. Requirements previos MODIFIED

Base efectiva = specs de `messaging-bulk` e `inbox-template-send` (implementados pero **aún no archivados**
a `openspec/specs/` — deuda de archivado; el spec/design decide si archiva primero o hace delta-sobre-delta):

- **`messaging-bulk`**: **SEND-2** (el worker invoca `sendTemplate` → ahora vía Chatwoot), **SEND-3**
  (backoff/retry — Chatwoot añade capas de latencia/fallo), **SEND-4** (throughput ~80/s → ahora cola Sidekiq
  de Chatwoot, no nuestro `RateLimiter`), **HIST-3** (DTO de error curado — ahora el error viene de Chatwoot).
- **`inbox-template-send`**: **TS-5** (envío por el port — cambia el origen del error), **TS-6** (proyección
  post-OK — se simplifica reusando `upsertByChatwootMessageId`), **MODEL-1/PORT-1** (`providerMessageId`/
  `upsertTemplateMessage` pasan a opcionales/obsoletos para el nuevo path).
- **`messaging-inbox` (F1, archivado)**: SEND-1/2/3 (texto plano vía `ChatwootGateway.sendMessage` sin
  template_params) **NO se tocan**.
- **Nuevos requirements** (capability de send-vía-Chatwoot): extensión del `ChatwootGateway`
  (template_params + create conversation/contact), selección por flag, dedup por `chatwootMessageId`. El
  spec los estructura.

## 7. Activation steps (runbook — parte es infra fuera del repo)

1. **Deploy** de la migración que siembra el flag `messaging-send-via-chatwoot` (default OFF) + deltas de
   schema si los hubiera. Wiring de ambos adapters (Twilio-directo + Chatwoot) en composición.
2. **(Infra, fuera del repo)** Configurar en el host del VPS un **cron** que corra
   `docker exec <chatwoot> bundle exec rails runner "Channels::Twilio::TemplatesSyncJob.perform_now(<channel_id>)"`
   cada N min (los templates cambian rara vez — 15 min/horario es suficiente).
3. Correr el sync **una vez manual** y **verificar** que `channel.content_templates` del inbox contiene los
   templates **reales** (no los 5 de muestra).
4. **Smoke test con flag ON** para 1 conversación: enviar template desde el hilo → confirmar que aparece en
   el hilo de Chatwoot, que el mirror upsertea por `chatwootMessageId`, y que un template deliberadamente
   inválido aflora `failed` vía `message_updated`.
5. **Flip flag ON** en la UI de feature flags (primero send-desde-hilo, luego bulk). **Fallback**: togglear
   OFF → revierte a Twilio-directo al instante.

## 8. Risks (verificados)

1. **Sync de templates manual/stale (BLOQUEANTE hasta activarlo)** — sin el cron (§A) + sync inicial, el
   flip NO funciona (todo template real → `Template not found`). Mitigado por §7.2-3 + flag OFF + gate de
   aprobación en el BE.
2. **Throughput del bulk** — ≥1-2 calls HTTP/destinatario + el envío real a Twilio queda en la cola Sidekiq
   de Chatwoot, **fuera de nuestro `RateLimiter.acquire()` (~80/s)**. Riesgo de desalinear el throttle real
   a Twilio. Mitigación: mantener nuestro rate-limiter sobre los POST a Chatwoot (protege a Chatwoot),
   aceptar que el throttle Twilio-facing pasa a ser de Chatwoot, monitorear su cola.
3. **Visibilidad de estado degradada** — delivered/read invisibles (paridad con hoy, no regresión); solo
   failed detectable (§B).
4. **Timing async de fallos** — el fallo real llega después del 201, no síncrono; shift de UX del composer
   (mitigado: status del mirror + proyección `failed`; contrato intacto §D).
5. **`TemplateSyncService.derive_status` siempre `'approved'`** — Chatwoot puede intentar enviar un template
   NO aprobado por Meta. Mitigado manteniendo el gate real (TPL-2/CAMP-2/TS-3) contra Twilio Content API vía
   `TemplateAdminPort` **antes** de emitir `template_params.name`.
6. **Fuera de ventana sin template_params** — Chatwoot manda igual, Twilio rechaza (~63016), aflora `failed`
   async. Mismo manejo que §4.
7. **Doble-path durante rollout** — ambos adapters cableados (temporal, se limpia al consolidar).
8. **Deuda de archivado** — `messaging-bulk`/`inbox-template-send` sin archivar a `openspec/specs/`; el spec
   emite MODIFIED como delta-sobre-delta (decisión del spec/design).

## 9. Artefactos

- `openspec/changes/chatwoot-hub-sendpath/proposal.md` (este archivo)
- Engram: `topic_key: "sdd/chatwoot-hub-sendpath/proposal"`, `project: "ipnext-backend"`, `type: architecture`
- Insumos: `sdd/chatwoot-hub-sendpath/explore`, `sdd/chatwoot-hub-sendpath/decision`
