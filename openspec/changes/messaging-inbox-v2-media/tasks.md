# Tasks — messaging-inbox-v2-media · Tanda 1 (RECIBIR MEDIA)

TDD estricto (RED→GREEN→REFACTOR), in-memory ports, sin mockear Prisma. BE/FE en
paralelo contra el contrato ya cerrado del spec (DTO/endpoint).

## BACKEND (`ipnext-backend`)

### B1. Foundation — modelo + puertos (bloquea B2-B6)
- [ ] B1.1 `prisma/schema.prisma`: modelo `ChatMessageAttachment` + `ChatMessage.attachments[]` (contrato spec.md, clon `20260823000000_add_scheduled_task_attachment`).
- [ ] B1.2 Migración aditiva `prisma/migrations/{ts}_add_chat_message_attachment/`. Test integration: FK cascade + unique `chatwootAttachmentId` (scenario 25).
- [ ] B1.3 `domain/ports/ChatMessageAttachmentRepository.ts`: upsertByChatwootAttachmentId (no revierte `downloaded`), listByMessageIds, findById, listRetriable, markDownloaded, markFailed.
- [ ] B1.4 RED+GREEN `InMemoryChatMessageAttachmentRepository.ts` + test: upsert idempotente no pisa `downloaded`/`storageKey` (scenario 2).
- [ ] B1.5 `PrismaChatMessageAttachmentRepository.ts` (impl real).
- [ ] B1.6 `domain/ports/ChatMediaDownloadTrigger.ts` `{ requestDownload(id): void }`.
- [ ] B1.7 `domain/errors/chatAttachment.ts`: `AttachmentTooLargeError`(413), `ChatAttachmentNotFoundError`(404), `ChatAttachmentNotReadyError`(409); reusar `StorageNotConfiguredError`. Registrar en `errorHandler.ts` statusMap.

### B2. MEDIA-1 — captura sync (depende B1)
- [ ] B2.1 RED `ReceiveChatwootWebhook.test.ts`: idempotencia 2 webhooks→1 fila (1), retry no revierte downloaded (2), content='' + attachment se persisten ambos (3), fileType no-binario ignorado (4).
- [ ] B2.2 GREEN: `ChatwootWebhookPayload.attachments?: RawAttachment[]`. **Ambigüedad**: confirmar path real (`payload.attachments[]` vs `data.attachments[]`) — el scratchpad `chatwoot-media-payload.md` citado en proposal ya no existe en el repo; verificar contra `.37`.
- [ ] B2.3 `ReceiveChatwootWebhook.handleMessageCreated`: upsert attachments en la rama existente + `trigger.requestDownload(id)` aislado en try/catch (no debe abortar el 200 — scenario 24).
- [ ] B2.4 RED+GREEN paridad fetch-on-open (scenario 5): `RawChatwootMessage`/`ChatwootMessageDto`/`toMessageDto` (`HttpChatwootGateway.ts`) + `GetConversation.syncFromChatwoot` ganan `attachments`.

### B3. MEDIA-2 — descarga (dep. B1; paralelo a B2)
- [ ] B3.1 RED `DownloadChatMessageAttachment.test.ts`: happy path imagen+thumb (6), tamaño excedido→failed sin subir (7), follow-redirect sin auth cross-host (8), red caída→markFailed+attempts (9), ya downloaded→no-op (10).
- [ ] B3.2 GREEN `ChatwootGateway.downloadAttachment(url): Promise<{buffer,contentType}>` + impl `HttpChatwootGateway` (sigue 301, strip headers auth en redirect cross-host).
- [ ] B3.3 GREEN `application/use-cases/messaging/DownloadChatMessageAttachment.ts`: valida tamaño por fileType (5/16/100MB) contra `sizeBytes` y bytes reales, `FileStorage.save({key:"messaging/{conversationId}/{id}.ext"})`, thumb si image+thumbSourceUrl, markDownloaded/markFailed.

### B4. MEDIA-3 — scheduler (dep. B3)
- [ ] B4.1 RED `ChatMediaDownloadScheduler.test.ts` (clon `RadiusAuthIngestScheduler.test.ts`): recupera pending (11), reintenta failed<5 (12), excluye attempts>=5 (13), flag off→skip (14), 1 falla no detiene el resto (15).
- [ ] B4.2 GREEN `infrastructure/scheduling/ChatMediaDownloadScheduler.ts` (clon exacto `RadiusAuthIngestScheduler.ts`: setInterval+inFlight+DistributedLock+flag `chat-media-download`) + `bootstrapChatMediaDownload.ts` (clon `bootstrapRadiusAuthIngest.ts`).

### B5. MEDIA-4/5 — DTO + endpoint (dep. B1, B3)
- [ ] B5.1 RED `messaging.ts` dto test: no leak `sourceUrl`/`storageKey`/`lastError` (16), `status` passthrough, `thumbUrl` null sin thumb (17).
- [ ] B5.2 GREEN `application/dto/messaging.ts`: `ChatMessageAttachmentDto` + `toChatMessageAttachmentDto`, `ChatMessageDto.attachments`; `ChatMessageRecord`/`ChatMessageRepository.listByConversation` incluyen attachments (anti-N+1 vía `listByMessageIds`/Prisma `include`).
- [ ] B5.3 RED `GetChatAttachmentFile.test.ts` + route test: sirve original (18), thumb con fallback (19), 409 not ready (20), 404 (21), 403 sin permiso (22), `next(err)` si el repo lanza (23).
- [ ] B5.4 GREEN `application/use-cases/messaging/GetChatAttachmentFile.ts` (clon `GetTaskAttachmentFile.ts`) + ruta `GET /attachments/:id/file?variant=` en `messaging.routes.ts`, gated `messaging:read`, `contentDisposition` clonado de `taskAttachments.routes.ts`.

### B6. Wiring (dep. B1-B5)
- [ ] B6.1 `app.ts`: instanciar repo/use cases/trigger/`GetChatAttachmentFile`, registrar `ChatMediaDownloadScheduler` en el array de bootstrap junto a los demás, reusar la MISMA instancia `MinioFileStorage` de task-photos.
- [ ] B6.2 Test integración final: los 25 scenarios corren verdes en conjunto (`npm test` scoped a `messaging`).

## FRONTEND (`ipnext-frontend`)

### F1. Extraer lightbox (ANTES de consumir — no romper tareas)
- [ ] F1.1 Mover `Lightbox` (`TaskPhotosGallery.tsx:60-144`) + CSS (`TaskPhotosGallery.module.css:227-297`) a `src/components/media/ImageLightbox.tsx`+`.module.css`, API idéntica `{url,alt,onClose}`.
- [ ] F1.2 `TaskPhotosGallery.tsx` importa `ImageLightbox`; correr `src/__tests__/scheduling/TaskPhotosGallery.test.tsx` — DEBE seguir verde (gate de regresión).

### F2. Tipos + utils (sin dep., paralelo a F1)
- [ ] F2.1 RED+GREEN `src/utils/formatFileSize.ts` (bordes: 0/null/negativo/<1KB/KB/MB) + test.
- [ ] F2.2 `WhatsappChatMessageAttachment` en `src/types/whatsapp.ts` + `WhatsappMessage.attachments[]` (espejo DTO B5.2).
- [ ] F2.3 `mediaIcons.tsx`: SVG por `contentType` (pdf/zip/doc/sheet/generic), nunca emoji.

### F3. Hojas de media (dep. F1, F2 — TDD por componente)
- [ ] F3.1 RED+GREEN `MediaPlaceholder` (type-aware, `aspect-ratio` de width/height, `role=status`).
- [ ] F3.2 RED+GREEN `MediaError` (`role=alert`, botón "Reintentar" = re-check, no re-dispara BE).
- [ ] F3.3 RED+GREEN `MediaImage`: alt, click/Enter→`ImageLightbox`, onError→roto, **test regresión 409**: `src` solo se monta si `status==='downloaded'`, blur-up onLoad.
- [ ] F3.4 RED+GREEN `MediaVideo`/`MediaAudio`: `<video/audio controls preload="metadata">`.
- [ ] F3.5 RED+GREEN `MediaFile`: ícono por contentType, filename fallback, `formatFileSize`, `href+download`.
- [ ] F3.6 RED+GREEN `MediaAttachment` (router status→fileType) + `MediaAttachments` (layout: single/grid≥2 imgs/stack mixto).
- [ ] F3.7 `Media.module.css` compartido (tokens, blur-up, stagger, hover/press — design §7-8).

### F4. `MessageBubble` (dep. F3)
- [ ] F4.1 RED test: mensaje solo-media (`content===''`) no pinta `<span></span>` fantasma.
- [ ] F4.2 GREEN `MessageBubble.tsx:73`: `{content.trim()!=='' && <span>...}` + `<MessageAttachments attachments={...}/>` si `attachments.length`.

### F5. Cierre
- [ ] F5.1 Test contraste labels de media ≥4.5:1 (mismo criterio `MessageBubble.contrast.test.tsx`).
- [ ] F5.2 Suite completa verde: `TaskPhotosGallery` (regresión) + todos los `Media*`/`formatFileSize`/`MessageBubble`.
