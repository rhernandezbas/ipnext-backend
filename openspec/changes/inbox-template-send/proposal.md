# Proposal — inbox-template-send (enviar template aprobado desde el hilo con ventana expirada)

## 1. Why / Intent

Visión del usuario (2026-07-16): en el inbox WhatsApp, cuando la ventana de 24h está expirada, el
composer solo muestra el aviso estático `"Ventana de 24h expirada — se necesita un template"`
(`FE Composer.tsx:45`, rama `mode==='reply' && !isDetailLoading && !isDetailError && !canReply`,
`Composer.tsx:240-244`) y NO deja hacer NADA. Queremos lo que hace Chatwoot: **elegir un template
APROBADO y mandarlo desde el hilo** (con sus variables), y que el mensaje quede en la conversación.

**Regla de plataforma (verificada por el usuario, queda documentada acá y en design D2):** la
ventana de 24h la abre SOLO un mensaje inbound del cliente; **los templates NO la abren**. Enviar
un template desde el hilo NO habilita el composer de texto libre — el composer se habilita recién
cuando el cliente responde (webhook → `canReply` cache, `schema.prisma:2828`).

## 2. Evidencia — por qué el camino actual NO puede hacer esto

| Hecho | Evidencia (file:line) |
|---|---|
| El composer detecta "ventana expirada" desde `canReply` del detalle (`GetConversation` fetch-on-open, poll 25s) — llega como prop, nunca math local de 24h | FE `WhatsappInboxPage.tsx:342` (`canReply={!!detail?.canReply}`), FE `useWhatsapp.ts:77-86`, BE `src/domain/ports/ConversationRepository.ts:33` |
| El envío actual va por Chatwoot: `POST /api/messaging/conversations/:id/messages` → `SendMessage` → `ChatwootGateway.sendMessage` (texto plano/media) | BE `messaging.routes.ts:399-438`, `SendMessage.ts:139-150` |
| `SendMessage` RECHAZA fuera de ventana ANTES de tocar Chatwoot: `!canReply` → 422 `MESSAGING_WINDOW_EXPIRED` (guard 2, orden PINNED) | BE `SendMessage.ts:122-124`, `errorHandler.ts:153` |
| Un template fuera de ventana NO puede ir por Chatwoot: el canal Chatwoot→Twilio manda texto plano; fuera de ventana Twilio lo rechaza. El template requiere `ContentSid` → Twilio Content API directo | BE `TwilioContentGateway.sendTemplate` (`TwilioContentGateway.ts:124-156`: `MessagingServiceSid` + `To: whatsapp:{E164}` + `ContentSid` + `ContentVariables`, form-urlencoded) |
| Ese camino Twilio-directo YA existe y está probado por el bulk: `TemplateMessagingPort.sendTemplate(to, contentSid, variables)` | BE `src/domain/ports/TemplateMessagingPort.ts:90-104`, usado por `SendCampaign.ts:143` |
| El bulk YA proyecta envíos Twilio-directo al inbox (Conversation + ChatMessage `origin:'bulk'`) — el hilo los renderiza sin cambios de DTO | BE `PrismaCampaignInboxProjector.ts:26-48`, `ChatMessageRepository.upsertBulkMessage` (`ChatMessageRepository.ts:39-56`), thread render origin-agnóstico (`ChatMessageRepository.listByConversation:58`, `dto/messaging.ts:267-280`) |
| Catálogo de templates YA existe: `GET /api/messaging/bulk/templates` (`ListTemplates` → `TemplateSummaryDto` con `body`, `variables[]`, `approvalStatus`, `sendable`) — pero gateado por `messaging.templates`, NO por el permiso del inbox | BE `messagingBulk.routes.ts:109-121`, `ListTemplates.ts:14-30`, wiring `app.ts:2646-2647` |
| Guard del envío del inbox = `messaging:send` (`requirePerm('messaging','send')`) — status/assignee/area ya reusan ESTE mismo guard | BE `app.ts:2582-2585`, `messaging.routes.ts:393-461` |

**Gap real**: no existe NINGÚN camino para que un agente del inbox dispare
`TemplateMessagingPort.sendTemplate` contra la conversación abierta, ni proyección del resultado
al hilo, ni UI para elegir template + variables.

## 3. Scope IN

### BE (este worktree, branch `feat/inbox-template-send`)

1. **`POST /api/messaging/conversations/:id/send-template`** `{templateRef, variables}` — guard
   `perms.send` (el MISMO del send actual, decisión pedida por el usuario). Use case nuevo
   `SendTemplateMessage`: valida template aprobado (criterio CAMP-2 de `CreateCampaign.ts:47-54`)
   + variables completas (criterio CAMP-3, `CreateCampaign.ts:56-63`) + resuelve el teléfono de la
   conversación (`contactPhoneE164`, fallback `toWhatsAppE164(contactPhone)`) →
   `TemplateMessagingPort.sendTemplate` → proyecta el `ChatMessage` al hilo (origin nuevo
   `'agent_template'`, idempotencia mirror por `providerMessageId` = SM sid de Twilio) + bump del
   preview de la conversación → devuelve `ChatMessageDto` (201).
2. **`GET /api/messaging/send-templates`** — catálogo curado para el picker del composer, guard
   `perms.send` (coherencia de capacidad: quien puede enviar el template puede ver qué templates
   hay; ver design D7 para el tradeoff vs reusar `/bulk/templates`). Reusa el use case
   `ListTemplates` tal cual.
3. Errores tipados: reusa `TEMPLATE_NOT_APPROVED`/`MISSING_TEMPLATE_VARIABLES`/
   `TEMPLATE_SEND_REJECTED`/`TEMPLATE_PROVIDER_*` (ya en statusMap, `errorHandler.ts:167-173`) +
   NUEVO `CONVERSATION_PHONE_MISSING` → 422.
4. Migración aditiva: `ChatMessage.providerMessageId String? @unique` (traza SM sid + clave de
   idempotencia de la proyección one-off).

### FE (`ipnext-frontend`, branch NUEVO `feat/inbox-template-send-fe` desde main)

5. El aviso estático de ventana expirada se convierte en **aviso + CTA "Enviar template"** (dentro
   del subtree del `Composer`, ya gateado por `<Can permission="messaging.send">`,
   `Composer.tsx:206`).
6. **`TemplateSendPanel`** (modal, molde a11y `PreviewModal.tsx:198-209` del bulk): Select PROPIO
   (`molecules/Select`) con SOLO templates aprobados, form de variables (un input por variable
   declarada, valores planos), preview del body con las variables sustituidas (reusa los patrones
   `splitTemplateBody`/`renderPreviewMessage` del bulk), confirm y envío. 4 ramas de estado
   (loading/error/empty/success). El mensaje aparece en el hilo al toque (append-on-success al
   cache de mensajes, mismo patrón `onSuccess` de `useSendWhatsappMessage`, `useWhatsapp.ts:203-213`).
7. `mapSendError` extendido con los códigos del template-send (única superficie de mapeo
   código→copy del envío, `mapSendError.ts:8-28`).

## 4. Scope OUT

- Abrir la ventana / habilitar el composer post-template (regla de plataforma: NO pasa — el
  composer sigue bloqueado hasta el inbound del cliente).
- Delivery-status callbacks de Twilio (el SM sid queda persistido para un futuro change).
- Badge visual "template" en la burbuja del hilo (el DTO no expone `origin`; el bulk ya renderiza
  como outbound normal — mismo criterio).
- Templates con media/botones (v1 = body de texto, mismo alcance que el bulk).
- Retry/backoff 429 del envío one-off (interactivo — el agente reintenta a mano; design D9).
- Tocar el flujo bulk, el CRUD de templates o el webhook.

## 5. Riesgos

- **Doble envío en retry manual**: el POST no es idempotente end-to-end (un retry del agente =
  nuevo SM sid = nuevo mensaje real). Mismo riesgo ya aceptado en el path Chatwoot
  (`SendMessage`); mitigación: el modal deshabilita confirm mientras `isPending` (design D6/D11).
- **Colisión con `inbox-resolve`** (en vuelo, worktree `inbox-resolve-be`): overlap textual
  append-only en `messaging.routes.ts`, `ConversationRepository.ts` (port), tests de rutas y FE
  `whatsapp.api.ts`/`useWhatsapp.ts`/`types/whatsapp.ts`. SIN overlap semántico (regiones
  distintas). Ver design §Colisiones — merge secuencial, rebase del segundo.
- **Permiso**: el catálogo del picker queda bajo `messaging:send` (ruta nueva) — un agente de
  inbox NO necesita `messaging.templates` (ese sigue siendo el permiso del catálogo bulk/CRUD).
