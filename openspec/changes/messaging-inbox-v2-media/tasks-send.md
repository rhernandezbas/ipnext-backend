# Tasks — messaging-inbox-v2-media · Tanda 2 (ENVIAR MEDIA)

TDD estricto (RED→GREEN→REFACTOR), in-memory ports/fakes, sin mockear Prisma/axios real.
Extiende `SendMessage` (NO use case nuevo). Refs `#N` = scenario de `spec-send.md`.

## Backend (`ipnext-backend`)

### BE1. Foundation — gateway multipart + error 415 + dep (bloquea BE2-BE4)
- [ ] BE1.1 [RED] `HttpChatwootGateway.test.ts`: sin `files` el POST sigue siendo JSON, cero regresión (#17).
- [ ] BE1.2 [RED] `HttpChatwootGateway.test.ts`: con 2 `files` → multipart, 2 partes `attachments[]`+`content`+`message_type`, `timeout`/`maxBodyLength` seteados (SEND-4 scenario 1).
- [ ] BE1.3 [RED] `HttpChatwootGateway.test.ts`: la respuesta mapeada trae `attachments[].id`/`sourceUrl` (SEND-4 scenario 3, ya cubierto por `toMessageDto` — solo agregar caso multipart).
- [ ] BE1.4 [RED] `HttpChatwootGateway.test.ts`: timeout/red caída en el POST multipart → `ChatwootUnavailableError`, nunca cuelga (#11).
- [ ] BE1.5 [GREEN] `package.json`: agregar `form-data` como dependencia **explícita** (`^4.0.0`, hoy transitiva de axios — correr install para fijar en lockfile).
- [ ] BE1.6 [GREEN] `domain/ports/ChatwootGateway.ts`: agregar `interface OutboundAttachmentFile { buffer: Buffer; filename: string; contentType: string }` (co-ubicada junto a `ChatwootMessageAttachmentDto`) y extender `sendMessage(chatwootConversationId, content, files?: OutboundAttachmentFile[])`.
- [ ] BE1.7 [GREEN] `HttpChatwootGateway.ts`: `sendMessage` arma `FormData` (pkg `form-data`) cuando `files.length>0` (`form.append('attachments[]', buffer, {filename,contentType})` por archivo + `content`+`message_type`), `headers: form.getHeaders()`, `timeout`/`maxBodyLength`/`maxContentLength` explícitos; sin `files` conserva el POST JSON actual.
- [ ] BE1.8 [GREEN] `domain/errors/chatAttachment.ts`: agregar `UnsupportedAttachmentTypeError` (`CHAT_ATTACHMENT_UNSUPPORTED_TYPE`, 415). **GOTCHA**: existe un homónimo en `domain/errors/taskAttachment.ts` (dominio scheduling) — son dos clases distintas, importar SIEMPRE la de `chatAttachment.ts` en este flujo.
- [ ] BE1.9 [GREEN] `errorHandler.ts` statusMap: registrar `CHAT_ATTACHMENT_UNSUPPORTED_TYPE: 415`.
- [ ] BE1.10 [GREEN] `helpers/FakeChatwootGateway.ts`: `sendMessage` acepta `files?` (firma del port), registra `files?.length` en `sendMessageCalls`, y `sendMessageResult` ya soporta `attachments[]` (reusa `ChatwootMessageDto.attachments` existente) — sin esto BE2 no puede testear el espejo.

### BE2. `SendMessage` extendido (dep. BE1)
- [ ] BE2.1 [RED] `SendMessage.test.ts`: `canReply=false` + archivo grande en el lote → 422 SIN validar `files` ni llamar Chatwoot (#1).
- [ ] BE2.2 [RED] conversación inexistente → 404 con o sin `files` (#2).
- [ ] BE2.3 [RED] archivo `contentType` no clasificable → 415, lote completo rechazado, gateway NUNCA llamado (#3).
- [ ] BE2.4 [RED] archivo excede su límite por `fileType` → 413, lote completo rechazado (#4).
- [ ] BE2.5 [RED] Chatwoot 503 con `files` → nada persistido (ni `ChatMessage` ni `ChatMessageAttachment`), `fileStorage.save` nunca invocado (#5).
- [ ] BE2.6 [RED] Chatwoot OK + MinIO OK → attachments `downloaded`, DTO poblado (#6).
- [ ] BE2.7 [RED] Chatwoot OK + MinIO falla → 201 igual, attachment `failed` con `sourceUrl=data_url`, `execute` NO lanza (#7).
- [ ] BE2.8 [RED] 3 `files` → alineación por índice `sent.attachments[i]`↔`files[i]` (#8).
- [ ] BE2.9 [RED] `content` + `files` (caption) ambos válidos (#9).
- [ ] BE2.10 [RED] `files` sin `content` (`content=''`) válido (#10).
- [ ] BE2.11 [RED] DTO outbound con adjuntos: sin leak de `sourceUrl`/`storageKey` (#16).
- [ ] BE2.12 [RED] webhook outgoing posterior sobre una fila ya `downloaded` — inofensivo (#18). **Ambigüedad**: ¿test nuevo en `SendMessage.test.ts` (repo compartido con un upsert posterior simulando el webhook) o extender `ReceiveChatwootWebhook.test.ts` de Tanda 1? Recomiendo lo segundo (la regla "no revierte downloaded" ya vive ahí, MEDIA-1 scenario 2) — decidir en apply.
- [ ] BE2.13 [GREEN] `SendMessage.ts`: constructor gana `attachmentRepo: ChatMessageAttachmentRepository` + `fileStorage: FileStorage`; `execute(conversationId, content, files?)`.
- [ ] BE2.14 [GREEN] orden de guardas pinneado: `findById`→404, `!canReply`→422 (ANTES de tocar `files`), validar TODO el lote upfront (derivar `fileType` del mimetype + revalidar `MAX_BYTES_BY_FILE_TYPE`)→415/413, `gateway.sendMessage`→catch→503.
- [ ] BE2.15 [GREEN] post-OK: por cada `sent.attachments[i]` → `upsertByChatwootAttachmentId` (pending, `sourceUrl=data_url`) → `fileStorage.save` → `markDownloaded`; si `save`/`markDownloaded` fallan → `markFailed`, NO abortar el envío ni el resto del lote.
- [ ] BE2.16 [GREEN] `toChatMessageDto(message, attachmentRecords)` en vez del default `[]`.
- [ ] BE2.17 [REFACTOR] `MAX_BYTES_BY_FILE_TYPE` está privada en `DownloadChatMessageAttachment.ts` — **decisión abierta**: exportarla desde ahí (single source) o duplicarla deliberadamente en `SendMessage.ts` (criterio ya usado en el repo para otros duplicados infra/application). Definir antes de escribir BE2.14.

### BE3. Endpoint multipart (dep. BE1, BE2)
- [ ] BE3.1 [RED] `messaging.routes.test.ts`: multipart `content`+2 `attachments[]` → 201 poblado.
- [ ] BE3.2 [RED] multipart solo `attachments[]` sin `content` → 201, `content=''`.
- [ ] BE3.3 [RED] ni `content` ni `attachments` → 400 `VALIDATION_ERROR`, `sendMessage.execute` NO invocado (#12).
- [ ] BE3.4 [RED] 11 archivos → 400 `TOO_MANY_FILES` (`LIMIT_FILE_COUNT`) (#13).
- [ ] BE3.5 [RED] archivo >100MB → 413 `FILE_TOO_LARGE`, ANTES del handler/use case (#14).
- [ ] BE3.6 [RED] POST JSON texto-solo — passthrough sin regresión (#15).
- [ ] BE3.7 [GREEN] `messaging.routes.ts`: `multer({storage:memoryStorage, limits:{fileSize:100MB, files:10}}).array('attachments',10)` SOLO en esta ruta + wrapper `LIMIT_FILE_SIZE`→413 / `LIMIT_FILE_COUNT`|`LIMIT_UNEXPECTED_FILE`→400 (clon `uploadPhotos` de `taskAttachments.routes.ts`).
- [ ] BE3.8 [GREEN] handler: `content=req.body.content??''`, `files=(req.files??[]).map(f=>({buffer,filename:f.originalname,contentType:f.mimetype}))`, validar al menos uno de `{content, files.length>0}`→400, `sendMessage.execute(id,content,files)`→201; `next(err)` cubre 404/413/415/422/503 vía statusMap (ya registrados, incl. BE1.9) — sin catch inline extra.

### BE4. Wiring + cierre (dep. BE1-BE3)
- [ ] BE4.1 [GREEN] `app.ts` línea ~2539: `new SendMessage(conversationRepo, chatMessageRepo, chatwootGateway, chatAttachmentRepo, taskPhotoStorage)` — ambas instancias ya existen (líneas 2501/1756), sin infra nueva.
- [ ] BE4.2 Test integración final: los 18 scenarios de `spec-send.md` verdes en conjunto (`npm test` scoped a `messaging`).

## Frontend (`ipnext-frontend`)

### FE1. Tipos + validación + mapeo de error (sin dep., paralelo a FE3)
- [x] FE1.1 [RED+GREEN] `src/types/whatsapp.ts`: agregar `DraftAttachment`, `PendingSend`.
- [x] FE1.2 [RED+GREEN] `src/utils/validateAttachment.ts`: `deriveFileType`, `MAX_BYTES_BY_FILE_TYPE`, `MAX_FILES=10`, `validateFile` (espejo BE — **contract test** en FE6.1).
- [x] FE1.3 [RED+GREEN] `src/utils/mapSendError.ts`: code→copy (`UNSUPPORTED_ATTACHMENT_TYPE`, `ATTACHMENT_TOO_LARGE`/`FILE_TOO_LARGE`, `TOO_MANY_FILES`, `MESSAGING_WINDOW_EXPIRED`, `CHATWOOT_UNAVAILABLE`, `CONVERSATION_NOT_FOUND`, default).
- [x] FE1.4 [RED+GREEN] `mediaIcons.tsx`: agregar `IconPaperclip` (SVG inline, `stroke=currentColor`, nunca emoji).

### FE2. API + hook de envío (dep. FE1)
- [x] FE2.1 [RED] `whatsapp.api.test.ts`: `sendWhatsappMessage` sin `files` → JSON idéntico a hoy.
- [x] FE2.2 [RED] con `files` → `FormData` multipart field `attachments`, `onUploadProgress` reporta `loaded/total`.
- [x] FE2.3 [GREEN] `whatsapp.api.ts`: `SendMessageInput{content,files?,onUploadProgress?}`, rama JSON/FormData.
- [x] FE2.4 [RED] `useWhatsapp.send.test.ts`: `onMutate` mete `PendingSend` en `['whatsapp','pendingSends',id]`; progreso patchea; `onSuccess` revoca objectURLs+remove pending+append real dedup+`cancelQueries`; `onError`→`status:'failed'` sin relanzar; `retry` re-muta; `discard` revoca+remueve.
- [x] FE2.5 [RED] el poll (`setQueryData` sobre `whatsappMessagesKey`) NO toca `pendingSends`. **GOTCHA jsdom**: mockear `URL.createObjectURL`/`revokeObjectURL` (no existen en jsdom, mismo gap que `matchMedia` en `MessageBubble`).
- [x] FE2.6 [GREEN] `useWhatsapp.ts`: `usePendingSends` (`enabled:false`, cache-como-store) + `useSendWhatsappMessage` extendido (`send`/`retry`/`discard`, design §6.3).
- [x] FE2.7 [GREEN] exportar `whatsappPendingSendsKey`.

### FE3. Estado local de drafts (dep. FE1, paralelo a FE2)
- [x] FE3.1 [RED] `useComposerAttachments.test.ts`: `add` valida+crea objectURL; `add` sobre el tope (10) recorta + feedback; `remove` revoca objectURL (spy); unmount revoca todos.
- [x] FE3.2 [GREEN] `useComposerAttachments.ts`: `add`/`remove`/`clear`/`hasBlocking`, dueño del ciclo de vida `objectURL`.

### FE4. Composer UI (dep. FE1, FE2, FE3)
- [x] FE4.1 [RED] `ComposerAttachButton.test.tsx`: click abre picker; `onChange` mapea files + resetea `value`; a11y `aria-label`.
- [x] FE4.2 [GREEN] `ComposerAttachButton.tsx` (clip SVG + `<input type=file hidden>`, molde `TaskPhotosGallery`).
- [x] FE4.3 [RED] `AttachmentPreviewItem.test.tsx`: image→`<img>`; file/video/audio→icono+nombre+size (design FE-3); error→`role=alert`+icono; quitar dispara `onRemove(id)`.
- [x] FE4.4 [GREEN] `AttachmentPreviewItem.tsx` + `ComposerAttachmentTray.tsx` (grid `overflow-x:auto`, `role=list`).
- [x] FE4.5 [RED] `Composer.test.tsx` (extender): enviar habilitado solo-files sin texto; disabled si algún draft con error; Enter envía media-sola; `onSuccess` limpia `content`+drafts.
- [x] FE4.6 [GREEN] `Composer.tsx`: integra tray+attach+`trySend` (`content.trim() || validFiles.length`), quita `mutation.isPending` del `disabled` global (spinner vive en la burbuja, no en el botón).
- [x] FE4.7 [GREEN] `Composer.attachments.module.css`: tokens del repo + animaciones (`scale-in` 200ms, stagger 40ms, exit 150ms, `prefers-reduced-motion`).

### FE5. `MessageBubble` + `MessageThread` (dep. FE2, FE4)
- [x] FE5.1 [RED] `MessageBubble.test.tsx` (extender): `deliveryStatus:'sending'`→progressbar; `'failed'`→Reintentar/Descartar; `undefined`→sin overlay (regresión inbound/outbound intacta).
- [x] FE5.2 [GREEN] `MessageBubble.tsx`: props opcionales `deliveryStatus`/`uploadProgress`/`onRetry`/`onDiscard`.
- [x] FE5.3 [GREEN] `MessageThread.tsx`: merge server+pending (`toOptimisticMessage`), `status:'downloaded'` con `url=objectURL` (NUNCA `'pending'` — evita el skeleton). También se wireó `WhatsappInboxPage.tsx` (glue no enumerado explícitamente en tasks, pero necesario para que `pendingSends`/`retry`/`discard` lleguen de verdad al thread).

### FE6. Cierre
- [x] FE6.1 Contract test: `MAX_BYTES_BY_FILE_TYPE`/`MAX_FILES` FE == valores de `spec-send.md` BE (evita drift). Implementado como aserciones de valor literal en `validateAttachment.test.ts` (5/16/16/100MB, MAX_FILES=10) — no hay import cross-repo posible desde el worktree FE.
- [x] FE6.2 Suite completa verde: `Composer`, `MessageBubble`, `useWhatsapp`, `useComposerAttachments`, `validateAttachment`, `mapSendError`. Verificado con `npx vitest run whatsapp` (44 files/357 tests) + los 3 archivos no matcheados por ese patrón (32 tests) + suite completa del repo (`npx vitest run`: 505 files/5006 tests, 0 failures) + `tsc --noEmit` limpio.

---

## Dependencias entre tracks
BE1 (gateway) bloquea BE2 (use case) bloquea BE3 (endpoint) bloquea BE4 (wiring).
FE1 (tipos/validación) bloquea FE2 (hook) y FE3 (drafts) en paralelo; ambos bloquean FE4 (composer); FE4+FE2 bloquean FE5 (bubble/thread). El contrato del endpoint (BE3) es la única dependencia CRUZADA dura: FE2 puede escribirse contra el contrato ya cerrado del spec sin esperar a que BE3 esté mergeado (mismo patrón "BE/FE en paralelo" de Tanda 1).
