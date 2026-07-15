# Change 2 (BE) — Bulk deja rastro en el inbox + etiqueta por campaña

> EPIC Bulk v2 · PARALELO con C3 · mergea DESPUÉS de C3 · Fase 1+2 COMPLETO · TDD estricto (Jest + in-memory)
> ⚠️ CHECKPOINT: la migración NO se pushea sin revisar el SQL con el usuario. Fase 2 (webhook) = el mayor riesgo, aislada.

## Objetivo
(#2) Que el mensaje que el BULK envía a un cliente QUEDE en el hilo del inbox (hoy NO: bulk sale por Twilio directo salteando Chatwoot → nunca aterriza en Conversation/ChatMessage). (#1) Etiqueta por campaña en el inbox.

## Contexto verificado
- El thread renderiza CUALQUIER `ChatMessage` de la conversación (`PrismaChatMessageRepository.listByConversation:59` filtra por conversationId, ordena por chatwootCreatedAt) → **para mostrar el mensaje bulk NO hace falta cambiar el FE del thread; basta la fila**.
- `CreateCampaign` ya tiene `template.body` en mano (`:44-48`) → de ahí sale el texto (persistir en `Campaign.templateBody`).
- Las 2 `@unique` son sobre columnas `Int` NOT NULL. En PG un UNIQUE trata NULLs como distintos → volverlas nullable es aditivo y permite N filas bulk.

## SCHEMA (aditivo, menor riesgo) — `prisma/schema.prisma`
| Modelo | Cambio |
|---|---|
| Conversation | `chatwootConversationId Int? @unique` (nullable) + `origin String @default("chatwoot")` + `contactPhoneNormalized String?` (@@index) |
| ChatMessage | `chatwootMessageId Int? @unique` (nullable) + `origin String @default("chatwoot")` + `campaignRecipientId String? @unique` (FK→CampaignRecipient, key de idempotencia del msg bulk) |
| CampaignRecipient | `conversationId String? @relation(onDelete: SetNull)` (lazo recipient↔Conversation, sirve para proyección Y etiqueta) |
| Campaign | `templateBody String?` (body capturado en CreateCampaign para renderizar al enviar) |

### Migración (reglas WORKFLOW):
- Generar el SQL SIN DB local: `git show HEAD:prisma/schema.prisma > /tmp/before.prisma; npx prisma migrate diff --from-schema /tmp/before.prisma --to-schema prisma/schema.prisma --script`.
- ADD COLUMN + CREATE INDEX = aditivas seguras. `ALTER COLUMN ... DROP NOT NULL` = widening, no destructivo (el índice único se conserva). Backfill de `contactPhoneNormalized` = best-effort, **SIN guard RAISE EXCEPTION** (null = "no matcheable aún", degradación segura). **NO `BEGIN`/`COMMIT` dentro del migration.sql.** Timestamp posterior a la última migración.
- **⚠️ NO pushear. Dejar el SQL generado listo para que el orquestador lo revise con el usuario (checkpoint).**
- Correr `npx prisma generate` local para que el cliente tipe los campos nuevos.

## PROYECCIÓN (Fase 1)
- Port NUEVO `src/domain/ports/CampaignInboxProjector.ts`: `projectSentMessage({recipient, candidate, renderedBody, sentAt, providerId}): Promise<void>`.
- Adapter NUEVO `PrismaCampaignInboxProjector` (compone Conversation + ChatMessage repos).
- Inyectar en `SendCampaign` como **5º arg OPCIONAL** (molde del `optOutSource` opcional de ReceiveChatwootWebhook). Llamar DESPUÉS de `persistRecipientSent` (`SendCampaign.ts:152`).
- **CRÍTICO idempotencia/resumibilidad:** la proyección es best-effort e AISLADA — si falla, loguear y seguir; **JAMÁS volar processRecipient ni marcar failed** (el envío ya se aceptó; re-marcarlo failed re-enviaría). Misma disciplina que `persistRecipientSent` (FIX-5) y el opt-out fail-open. Idempotente por `campaignRecipientId` (upsert).
- `ConversationRepository.upsertBulkByPhone(phoneNormalized, {...origin:'bulk'})` NUEVO y SEPARADO de `upsertByChatwootId` (no pisa el write-path de Chatwoot, disciplina de `updateLocalFields`). Busca la conversación más reciente con ese `contactPhoneNormalized` (cualquier origen); existe→appendea (cae en la conversación que el cliente YA tiene); no→crea origin:'bulk'.
- `ChatMessage` bulk: `direction:'outbound'`, `content=renderedBody`, `chatwootCreatedAt=sentAt`, `chatwootMessageId=null`, `origin:'bulk'`, `campaignRecipientId=recipient.id`.
- `recipient.conversationId = conversation.id` (agregar al `CampaignRecipientPatch`, updateRecipient ya existe).
- Helper puro `renderTemplateBody(templateBody, variables)` (junto a `resolveCampaignVariables`). `templateBody` se persiste en CreateCampaign desde `template.body`.

## ETIQUETA (#1) — computada, sin modelo de labels
- La verdad = lazo `CampaignRecipient(conversationId, campaignId)` (patrón asignación-local F1.5-C2, `assigneeId/areaId`).
- Filtro `GET /conversations?campaignId=X` → `messaging.routes.ts:317` (junto a `assignment`) + filtro en `PrismaConversationRepository.list` (JOIN Conversation×CampaignRecipient, molde del filtro assigneeId `:144`).
- `ConversationListItemDto +campaigns:{id,name}[]` (o el más reciente), resuelto por JOIN en el mapper `:235`. Evitar N+1 con include/agregación.

## FASE 2 — reconciliación (AISLADA, mayor riesgo)
- En `ReceiveChatwootWebhook.handleConversationCreated` (`:334`) / handleMessageCreated: ANTES de `upsertByChatwootId`, "adoptar" una conversación `origin:'bulk'` con `chatwootConversationId=null` y mismo `contactPhoneNormalized` → setearle el chatwootConversationId in-place **conservando el `id`** (recipient.conversationId sigue válido, sin repoint). NUNCA tocar una conversación Chatwoot existente.
- Bien testeada: el síntoma de bug = conversación duplicada.

## Scenarios (TDD)
- Proyección: al enviar OK, se crea/actualiza Conversation(origin bulk o existente por teléfono) + ChatMessage outbound con renderedBody; recipient.conversationId seteado.
- Idempotencia: re-proyección (mismo campaignRecipientId) NO duplica el ChatMessage.
- Best-effort: si el projector tira, processRecipient NO marca failed ni vuela (el sent se preserva).
- Sin projector inyectado (5º arg ausente): SendCampaign se comporta EXACTO como hoy (backcompat).
- Etiqueta: `?campaignId=X` filtra las conversaciones de esa campaña; el DTO trae `campaigns`.
- Fase 2: cliente responde → adopta la conversación bulk (mismo id, ahora con chatwootConversationId) → NO duplica.
- Render: `renderTemplateBody` sustituye {{n}} con las variables.

## Tasks
- [ ] T1 schema.prisma + `prisma migrate diff` → SQL de migración (NO pushear) + `prisma generate`. **CHECKPOINT SQL.**
- [ ] T2 tests + port CampaignInboxProjector + adapter + upsertBulkByPhone + upsertBulkMessage (idempotente). RED→GREEN.
- [ ] T3 tests + SendCampaign proyección (best-effort, backcompat sin projector) + renderTemplateBody + CreateCampaign persiste templateBody. RED→GREEN.
- [ ] T4 tests + filtro campaignId (messaging.routes + PrismaConversationRepository.list + DTO campaigns). RED→GREEN.
- [ ] T5 tests + FASE 2 reconciliación en ReceiveChatwootWebhook (adopción conservando id, no duplica, no toca Chatwoot existente). RED→GREEN. AISLADA.
- [ ] T6 composition-root pin (SendCampaign recibe el projector en app.ts).
- [ ] T7 gate: `npm test` archivos del change + `tsc --noEmit`. NO commitear.
```