# Explore — messaging-inbox-v2-media (F1.5, fase A — MEDIA)

> Investigación READ-ONLY. Ningún archivo de código fue modificado. Repos: BE
> `ipnext-backend` (este repo) y FE `ipnext-frontend`.
>
> Contexto ya resuelto (no re-investigado acá): F1 (inbox texto) y F1.5-B
> (contexto rico) YA en prod. El payload real de Chatwoot con adjuntos fue
> **verificado en vivo** contra el código fuente de Chatwoot v4.13.0
> (`chatwoot-media-payload.md`, ver también `openspec/changes/messaging-inbox-v2/explore.md`
> Grupo A). Decisión ya tomada por el usuario: **storage = MinIO propio** (el
> BE descarga de Chatwoot y re-sube a nuestro MinIO; el mirror queda
> autónomo). Esta exploración es la continuación puntual de esa base, con
> file:line reales del patrón a clonar (task-photos).

---

## Área 1 — BE storage / patrón task-photos (LA referencia a clonar)

### Qué existe

El repo tiene un patrón COMPLETO, maduro y con hardening real (timeouts,
compensación transaccional, anti decompression-bomb) para adjuntos binarios.
Es clonable casi 1:1:

| Pieza | Archivo | Notas |
|---|---|---|
| Port de storage | `src/domain/ports/FileStorage.ts:8-19` | `save({key,buffer,mimeType})` / `get(key)` / `delete(key)`. **Agnóstico de bucket** — la key la genera el use case, el storage solo persiste. Esto importa: se puede REUSAR la misma instancia/bucket para chat, solo cambiando el prefijo de key (ver decisión abierta §Bucket). |
| Adapter MinIO | `src/infrastructure/adapters/minio/MinioFileStorage.ts:73-202` | Constructor LAZY (no valida config hasta el primer uso → `StorageNotConfiguredError` 503, el boot nunca truena si faltan `MINIO_*`, líneas 80-112). `ensureReady()` memoiza la promesa de `bucketExists`/`makeBucket` para evitar carreras (líneas 123-143). Todo con `withTimeout` (15s default, línea 34/146-153) — un MinIO mudo nunca cuelga el request. |
| Adapter in-memory (tests) | `src/infrastructure/adapters/in-memory/InMemoryFileStorage.ts:7-21` | `Map<key, {buffer,mimeType}>`. Directamente reusable para tests de la nueva feature. |
| Config / env | `src/infrastructure/config.ts:321-335` | `MINIO_ENDPOINT/PORT/USE_SSL/ACCESS_KEY/SECRET_KEY/BUCKET`, bucket default `'task-photos'`. Hoy es UN bucket, UNA instancia de `MinioFileStorage`, wireada en `app.ts`. |
| Rutas HTTP | `src/infrastructure/http/routes/taskAttachments.routes.ts:1-181` | multer memoryStorage, `MAX_FILE_BYTES = 10 MiB` (línea 17), `MAX_FILES = 15` (línea 18), campo `photos` (línea 19). Wrapper de multer traduce `LIMIT_FILE_SIZE`/`LIMIT_FILE_COUNT` a 413/400 (líneas 78-95, nunca 500). `Content-Disposition` RFC 5987 seguro para filenames no-ASCII (líneas 29-32). Endpoints: `POST /:taskId/attachments` (multipart), `GET /attachments/:id/file?variant=thumb|original`, `DELETE /attachments/:id`. |
| Use case de subida | `src/application/use-cases/AttachPhotosToTask.ts:71-215` | Flujo: (1) tarea existe → 404; (2) validación UPFRONT de todo el lote — mimetype declarado (línea 92), buffer>0 (línea 96), magic-bytes real vía `ImageProcessor.inspect()` (línea 101) contra `SUPPORTED_DETECTED_TYPES` (línea 108, cierra SVG/HEIC/TIFF/GIF disfrazados), anti decompression-bomb por dimensiones ANTES de decodificar (línea 112, `MAX_IMAGE_PIXELS=50MP`); (3) cupo por tarea (línea 119-122, `MAX_ATTACHMENTS_PER_TASK=15`); (4) escritura ATÓMICA con compensación — si algo falla a mitad del lote, `Promise.allSettled` deshace TODO lo ya escrito (storage + repo, líneas 189-211), nunca deja huérfanos silenciosos (logea warn si la compensación misma falla). Thumbnail es BEST-EFFORT (si `ImageProcessor.process` falla, solo warn y sigue con el original, líneas 144-162). |
| Errores tipados | `src/domain/errors/taskAttachment.ts:12-66` | `UnsupportedAttachmentTypeError`(415), `TooManyAttachmentsError`(422), `AttachmentNotFoundError`(404), `ImageTooLargeError`(422), `StorageNotConfiguredError`(503, degrada sin tumbar el boot). |
| DTO / URLs BE-proxy | `src/application/dto/taskAttachment.dto.ts:10-45` | **Nunca expone `storageKey`** — expone `fileUrl`/`thumbUrl` como rutas relativas a los endpoints BE-proxy (líneas 42-43). El storage real (MinIO) queda privado detrás del BE. Mismo patrón a clonar para adjuntos de chat. |
| Schema Prisma | `prisma/schema.prisma:1489-1503` `model ScheduledTaskAttachment` | `storageKey, filename, mimeType, sizeBytes, width?, height?, uploadedById`, `@@index([taskId])`. Migración: `prisma/migrations/20260823000000_add_scheduled_task_attachment` (aditiva, sin editar SQL a mano — regla del repo). |
| Image processing | `src/domain/ports/ImageProcessor.ts` (port) + `jimp` + `image-size` (`package.json:38-39`) | **Solo cubre jpg/png/webp**. No hay `ffmpeg`/`fluent-ffmpeg`/`ffprobe` en el repo — CERO capacidad de inspeccionar/generar poster-frame de video, ni de validar audio por magic bytes más allá de un chequeo de extensión/content-type. Esto es una brecha real para media de WhatsApp (ver Área 2 y decisiones abiertas). |

### Qué falta (para reusar en chat)
Nada nuevo de infraestructura — el port `FileStorage` y el adapter `MinioFileStorage` sirven TAL CUAL. Falta:
- Decidir bucket/key-prefix para chat (ver decisión abierta).
- Un `ImageProcessor`-equivalente para audio/video, o (recomendado para fase A) renunciar a generar thumbnail/inspección real para esos tipos y validar solo por `content_type`/extensión declarados por Chatwoot (más débil que el path de imagen, pero evita meter `ffmpeg` como dependencia nueva en esta fase).

### Esfuerzo: **Bajo** (es 100% reuso, cero código nuevo en esta área)

---

## Área 2 — Schema para attachments del mensaje

### Qué existe
`ChatMessage` (`prisma/schema.prisma:2782-2798`) es texto puro: `content: String`, sin ningún campo de adjunto. `ChatMessageRepository` (`src/domain/ports/ChatMessageRepository.ts:5-30`) expone solo `upsertByChatwootMessageId`/`listByConversation`, idempotente por `chatwootMessageId` (línea 27, `@unique` en schema línea 2786) — mismo patrón de idempotencia a replicar para el nuevo modelo.

### Propuesta (para `sdd-design`, no una decisión final de esta fase)

**Tabla 1:N `ChatMessageAttachment`**, clonando el molde exacto de `ScheduledTaskAttachment` + los campos propios de descarga async:

```prisma
model ChatMessageAttachment {
  id                  String      @id @default(uuid())
  messageId           String
  message             ChatMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
  chatwootAttachmentId Int        // id del adjunto en Chatwoot (idempotencia, igual criterio que chatwootMessageId)
  fileType            String      // 'image'|'audio'|'video'|'file' (string plano — mismo criterio que Conversation.status/ChatMessage.direction, NO enum Prisma)
  contentType         String      // MIME real reportado por Chatwoot (content_type)
  filename            String?     // Chatwoot no siempre lo da; derivar de extension si falta
  sizeBytes           Int?
  width               Int?
  height              Int?
  storageKey          String?     // NULL mientras status='pending' — recién se llena al bajar OK a MinIO
  thumbStorageKey     String?     // solo imagen; NULL para audio/video/file en fase A
  sourceUrl           String      // data_url de Chatwoot, capturado en el webhook, para el job de descarga (y reintentos)
  status              String      @default("pending") // 'pending' | 'downloaded' | 'failed'
  downloadAttempts    Int         @default(0)
  lastError           String?     // último mensaje de error del download job, para debug
  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @updatedAt

  @@unique([chatwootAttachmentId])
  @@index([messageId])
  @@index([status])            // el scheduler de reintento consulta por status='pending'/'failed'
}
```

- **1:N vs JSON**: se descarta JSON — WhatsApp permite multi-adjunto por mensaje (Chatwoot ya lo modela como array), y una tabla propia permite indexar por `status` para el job de reintento (imposible/incómodo sobre un campo JSON). Además espeja EXACTO el molde ya aprobado de `ScheduledTaskAttachment` (mismo team, misma convención, cero sorpresa para quien lea el schema).
- **`status`/`downloadAttempts`/`lastError`** son el único agregado real respecto a `ScheduledTaskAttachment` — necesarios porque acá la escritura del binario NO es síncrona con la creación de la fila (ver Área 3, sync vs async).
- Migración: aditiva, mismo patrón que `20260823000000_add_scheduled_task_attachment` — `npm run prisma:migrate`, nunca SQL a mano (regla del repo).

### Esfuerzo: **Bajo-Medio** (una tabla nueva + su índice; el diseño de campos ya está resuelto acá, falta que `sdd-design` lo confirme)

### Dependencias
- Debe cerrarse ANTES de tocar el mapper del webhook (Área 3) y el gateway de envío (Área 4) — ambos necesitan el shape final.

---

## Área 3 — Media ENTRANTE (webhook)

### Qué existe
- `ReceiveChatwootWebhook.handleMessageCreated` (`src/application/use-cases/messaging/ReceiveChatwootWebhook.ts:107-138`) — hoy solo lee `payload.content`. `ChatwootWebhookPayload` (líneas 26-45) NO declara `attachments`.
- El route handler (`src/infrastructure/http/routes/messaging.routes.ts:93-116`) responde **síncrono**: `await receiveChatwootWebhook.execute(...)` y RECIÉN DESPUÉS `res.status(200)`. Hoy esto es barato (solo escribe texto en Postgres). Si `handleMessageCreated` empezara a `await` la descarga de un archivo de 16MB desde Chatwoot y el re-upload a MinIO ANTES de responder 200, el webhook pasaría de ~10ms a potencialmente varios segundos por adjunto — Chatwoot tiene su propio timeout/retry de webhook y un handler lento arriesga reintentos duplicados (mitigado por el dedup de `WebhookDelivery`, pero igual es latencia innecesaria en el request path).
- Dedup ya resuelto en dos capas: `WebhookDelivery` (`prisma/schema.prisma:2804-2811`, único por `[source, deliveryId]`) a nivel ENTREGA, y `chatwootMessageId`/`chatwootAttachmentId` único a nivel EFECTO (idempotencia real). El nuevo `chatwootAttachmentId` único (Área 2) cubre reprocesar el mismo `message_created` sin duplicar attachments.
- **No hay cola de jobs (Bull/BullMQ/Redis) en todo el repo.** El patrón real y consolidado para "trabajo diferido" es **scheduler in-process**: `setInterval` + flag `inFlight` + `DistributedLock` (advisory lock de Postgres) + feature flag — repetido CASI IDÉNTICO en `RadiusAuthIngestScheduler.ts:32-48`, `RadiusAccountingIngestScheduler.ts`, `GestionRealSyncScheduler.ts`, `PppoeAutoMoveScheduler.ts`, `IClassClosureScheduler.ts`, `TaskAutocompleteScheduler.ts:37-57`. Además existe el molde `BackfillScheduler.ts:25-79` — **fire-and-forget on-demand** (`triggerNow()` dispara `void this.runOnce()` y retorna al instante, sin cron), justo el molde para "encolar la descarga de ESTE attachment ahora, sin bloquear el caller".

### Diseño propuesto (recomendado)

**Captura SYNC + descarga ASYNC (híbrido), NO todo-sync ni todo-cola-externa:**

1. **Dentro del webhook** (sync, rápido): `handleMessageCreated` lee `payload.attachments[]`, crea UNA fila `ChatMessageAttachment` por adjunto con `status='pending'`, `sourceUrl = data_url`, `fileType/contentType/sizeBytes/width/height` tal cual los reporta Chatwoot. **NO descarga el binario acá.** El webhook sigue respondiendo 200 en milisegundos, sin importar cuántos ni cuán pesados sean los adjuntos.
2. **Fire-and-forget inmediato** (clon de `BackfillScheduler.triggerNow`): apenas se crea la fila `pending`, el mismo proceso dispara `void downloadAndStoreAttachment.execute(attachmentId)` SIN esperarlo — en el caso feliz (Chatwoot responde rápido, archivo chico) el adjunto queda `downloaded` en el mirror segundos después del 200, sin que el webhook lo haya esperado.
3. **Scheduler de reintento** (clon EXACTO de `RadiusAuthIngestScheduler`/`TaskAutocompleteScheduler`: `setInterval` + `inFlight` + `DistributedLock('chat-media-download')`): cada N minutos barre `ChatMessageAttachment` con `status IN ('pending','failed')` y `downloadAttempts < MAX` y reintenta. Cubre: el proceso se reinició antes de terminar el fire-and-forget, Chatwoot estaba caído en el intento 1, o el 301 de `data_url` falló transitoriamente.
4. El use case de descarga (`GET data_url` siguiendo el 301 → buffer → `fileStorage.save()` → `update({storageKey, status:'downloaded'})`; en catch → `update({status:'failed', downloadAttempts:+1, lastError})`) es un solo lugar, invocado tanto por el fire-and-forget como por el scheduler — mismo código, dos disparadores.

**Por qué NO 100% síncrono dentro del webhook**: WhatsApp/Chatwoot permite audio/video hasta 16MB y documentos hasta 100MB (ver Área de límites) — descargar+re-subir eso ANTES de responder 200 es la clase de operación lenta que ya rompió el backend antes (ver el propio historial de commits del repo: sweeps de "504 latente" por handlers async lentos/sin manejo). Mantener el webhook flaco y mover el trabajo pesado a un job es consistente con esa lección ya aprendida en este mismo repo.

**Por qué NO una cola externa (Redis/BullMQ) recién en fase A**: cero infraestructura de colas existe hoy; introducirla para UNA feature es sobre-ingeniería en este punto — el patrón `setInterval+advisory lock` YA resuelve "reintentar trabajo fallido de forma distribuida" para 8+ features de este mismo repo. Si el volumen de media crece mucho, migrar a una cola real es un refactor futuro aislado (el use case de descarga no cambia, solo quién lo dispara).

### Qué falta
1. `ChatwootWebhookPayload.attachments?: Array<{...}>` — declarar el campo (Área 2 define el shape, ya verificado contra el payload real).
2. `ReceiveChatwootWebhook.handleMessageCreated` — mapear `payload.attachments` → filas `ChatMessageAttachment` (pending).
3. Nuevo use case `DownloadAndStoreChatAttachment` (o nombre similar) — puerto `HttpClient`/axios para seguir el 301 de `data_url`, `FileStorage.save`, `ChatMessageAttachmentRepository.update`.
4. Nuevo scheduler `ChatMediaDownloadScheduler` — clon de `RadiusAuthIngestScheduler`, wireado en `app.ts`/bootstrap junto a los demás.
5. `RawChatwootMessage`/`ChatwootMessageDto` (`HttpChatwootGateway.ts`) — declarar attachments para que el fetch-on-open (`GetConversation`) también los traiga (mismo dato, otro canal — Chatwoot GET API probablemente anida attachments igual que el webhook, a confirmar en `sdd-design`).

### Esfuerzo: **Alto** (toca webhook mapper, un use case nuevo, un scheduler nuevo, y el gateway GET)

---

## Área 4 — Media SALIENTE (gateway send)

### Qué existe
- `SendMessage.execute(conversationId, content)` (`src/application/use-cases/messaging/SendMessage.ts:31-64`) — un solo parámetro de texto. Guard order pinneado: 404 → `canReply=false` → 422 SIN llamar a Chatwoot → llamada a Chatwoot → cualquier fallo de axios → 503 SIN tocar el mirror (líneas 21-23, comentario explícito).
- `HttpChatwootGateway.sendMessage(chatwootConversationId, content)` (`HttpChatwootGateway.ts:77-85`) — `POST .../messages` con `{content, message_type:'outgoing'}` JSON puro, sin adjuntos.
- **Envío de media a Chatwoot YA VERIFICADO por el usuario** contra `MessageBuilder.process_attachments`: multipart con campo `attachments[]` (archivos) sobre el MISMO endpoint `POST /api/v1/accounts/{acc}/conversations/{conv}/messages`.

### Diseño propuesto
Clonar el patrón de `taskAttachments.routes.ts` para la RECEPCIÓN del archivo desde el agente (multer memoryStorage + límites — pero por-tipo, ver Área de límites), y extender el flujo así:
1. Agente sube archivo(s) desde el composer → BE recibe multipart.
2. BE decide SI también lo guarda en MinIO (ver decisión abierta — recomendado: SÍ, mismo criterio de consistencia que la recepción, y evita depender de que Chatwoot siga sirviendo ese binario después de reenviarlo).
3. BE reenvía el/los archivo(s) a Chatwoot vía multipart `attachments[]` (axios con `FormData`, agregar a `HttpChatwootGateway.sendMessage` un parámetro opcional de archivos).
4. Respuesta de Chatwoot (mensaje creado con sus propios `attachments[]` de vuelta) se persiste en el mirror igual que Área 3 (mismo `ChatMessageAttachment`, pero acá el binario YA está en MinIO desde el paso 2 — no hace falta re-descargar, `status='downloaded'` desde el vamos).

### Qué falta
1. `SendMessage.execute` — extender con un parámetro opcional de archivos (buffer+mimetype+filename), análogo a `AttachPhotoFile` de `AttachPhotosToTask.ts:43-47`.
2. `ChatwootGateway.sendMessage` (port) + `HttpChatwootGateway.sendMessage` (adapter) — aceptar attachments y armar el multipart (axios `FormData`, patrón nuevo en este gateway pero ya usado en el cliente de otros adapters del repo para multipart — a confirmar cuál).
3. Ruta `POST /conversations/:id/messages` (`messaging.routes.ts:190-208`) — pasar de JSON-only a aceptar multipart (mismo endpoint con Content-Type condicional, o separar en `POST .../messages/media`; decisión de `sdd-design`).
4. Errores tipados de adjunto (clonar `taskAttachment.ts`, pero con límites por-fileType).

### Esfuerzo: **Medio-Alto**

### Dependencias
- Depende de Área 2 (schema) cerrado. Puede ir en paralelo con Área 3 una vez el schema está firme (no dependen entre sí), pero AMBAS deben preceder al FE.

---

## Área 5 — FE Composer (adjuntar)

### Qué existe
- `Composer.tsx` (`ipnext-frontend/src/pages/whatsapp/WhatsappInboxPage/components/Composer.tsx:71-167`) — hoy es solo `<textarea>` + botón enviar, ligado a `useSendWhatsappMessage(conversationId)` (mutation react-query). El guard `disabled` (línea 87) ya combina `isDetailLoading || !canReply || mutation.isPending` — cualquier UI de adjunto deberá respetar el mismo guard (no se puede adjuntar si la ventana de 24h expiró, mismo criterio que texto).
- **Clon FE directo disponible**: `TaskPhotosGallery.tsx` (`ipnext-frontend/src/pages/scheduling/SchedulingTaskDetailPage/components/TaskPhotosGallery.tsx`) tiene TODO el patrón de picker: `<input type="file" multiple accept="..." className={styles.srOnly}>` disparado por un botón (líneas 226-228, 296-305), `handleFiles` con reset del input (línea 233) y validación de cupo ANTES de subir (líneas 236-239), feedback de éxito/error auto-dismiss con timer cancelable (líneas 216-224), `mapUploadError` (`ipnext-frontend/src/utils/mapUploadError.ts`, no leído en detalle en este batch pero referenciado) para traducir errores 415/422/413 del BE a copy legible.
- `taskAttachments.api.ts` (`ipnext-frontend/src/api/taskAttachments.api.ts:21-29`) — `FormData` multipart, campo `photos`. Mismo molde para `sendWhatsappMessage` con adjunto (cambiar campo a lo que decida Área 4, ej. `media`).
- `useTaskAttachments.ts` (`ipnext-frontend/src/hooks/useTaskAttachments.ts:20-29`) — mutation react-query con `invalidateQueries` on success. `useSendWhatsappMessage` (en `useWhatsapp.ts`, no releído en este batch — ya usado por `Composer.tsx` línea 73) es el hook a extender con el parámetro de archivo.

### Qué falta
1. Botón adjuntar (📎, ícono SVG — regla del repo, nunca emoji) + `<input type="file">` en `Composer.tsx`, clon de `TaskPhotosGallery`.
2. `sendWhatsappMessage` (`whatsapp.api.ts:53-56`) — pasar a `FormData` cuando hay archivo (hoy es `axiosClient.post(url, {content})` JSON puro).
3. `WhatsappMessage`/tipos (`types/whatsapp.ts:37-43`) — agregar attachments al tipo del mensaje (ver Área 6).
4. Preview antes de enviar (nombre + tamaño + thumbnail si es imagen) — no hay un patrón existente exacto para esto en `TaskPhotosGallery` (ahí se sube y se ve DESPUÉS en la galería, no hay preview previo al submit) — es UI nueva, aunque de bajo riesgo.
5. Progreso de subida — `axios` soporta `onUploadProgress`; no usado hoy en `taskAttachments.api.ts` (subida silenciosa). Si se quiere barra de progreso real, es adicional sobre el patrón clonado.

### Esfuerzo: **Medio** (el picker y el flujo de mutation son 90% clonables; preview + progreso son las piezas nuevas)

---

## Área 6 — FE Render de media en el thread

### Qué existe
- `MessageBubble.tsx` (`ipnext-frontend/src/pages/whatsapp/WhatsappInboxPage/components/MessageBubble.tsx:50-80`) — hoy renderiza SOLO `<span>{message.content}</span>` (línea 73). Sin ninguna rama condicional por tipo de contenido.
- `TaskPhotosGallery`'s `Lightbox` (`TaskPhotosGallery.tsx:60-144`) — lightbox accesible completo: focus-trap (líneas 74-98), `Escape` cierra (líneas 66-70), portal a `document.body` (línea 105), fallback a "no se pudo cargar" si la imagen rompe (líneas 63, 123-131, 136-138). 100% reusable para el visor de imágenes del chat.

### Qué falta
1. Rama condicional en `MessageBubble` por `fileType` (`image`→`<img>`+lightbox reusado, `video`→`<video controls>`, `audio`→`<audio controls>` (Chatwoot da `transcribed_text` — considerar mostrarlo como caption/accesibilidad), `file`→ícono + link de descarga con nombre+peso).
2. Estado "descargando…" / placeholder mientras `status='pending'` en el BE (ver decisión abierta) — el bubble debe poder pintar ALGO antes de que el job de descarga async termine, dado que el polling del thread (`THREAD-1`, ya existe para mensajes) puede traer el mensaje con adjunto `pending` antes de que el binario esté listo.
3. Mensaje solo-attachment (`content` vacío/null) — ya anotado por el review adversarial de F1 (`explore.md` de `messaging-inbox-v2`, línea ~31): hoy `content ?? ''` deja una burbuja vacía; con media esto se soluciona solo (el bubble ya no estará vacío, va a tener el adjunto), pero hay que asegurarse de NO renderizar un `<span></span>` fantasma cuando `content===''` Y hay attachment.
4. `WhatsappMessage` (types) — agregar `attachments: WhatsappChatMessageAttachment[]` (espejo de `ChatMessageAttachmentDto` del BE, con `fileUrl`/`thumbUrl` BE-proxy igual que `ScheduledTaskAttachmentDto`, NUNCA `storageKey`).

### Esfuerzo: **Medio** (el lightbox se reusa 100%; el trabajo real es la rama por-tipo + el estado pending)

### Dependencias
- Depende 100% de que el BE (Áreas 2+3) ya devuelva `attachments[]` en `ListMessages`/`GetConversation` — no se puede paralelizar con el mapper del BE, aunque SÍ se puede construir contra un mock mientras el BE cierra el contrato (mismo matiz que ya señaló el explore de F1.5 general).

---

## Faseo interno de A (recomendado)

| Orden | Paso | Por qué en ese lugar |
|---|---|---|
| A1 | **Schema** (`ChatMessageAttachment` + migración) | Todo lo demás depende del shape final de esta tabla. |
| A2 | **BE entrante** (mapper webhook + use case de descarga + scheduler de reintento) | Es el camino MÁS derisked: Chatwoot YA manda adjuntos reales en prod hoy mismo (se descartan silenciosamente) — con A1+A2 se puede validar el pipeline completo (webhook→pending→descarga→MinIO→`downloaded`) usando tráfico real, SIN esperar ningún cambio de FE. Además reutiliza 100% infraestructura ya probada (`FileStorage`/`MinioFileStorage`/patrón scheduler), bajo riesgo de diseño. |
| A3 | **BE saliente** (`SendMessage` extendido + gateway multipart) | Depende del mismo schema (A1) pero es independiente de A2 — puede ir en paralelo con A2 si hay dos personas, o inmediatamente después si es una sola. Menor derisking posible que A2 porque el envío multipart a Chatwoot todavía no se probó en vivo contra ESTE tenant (solo se leyó el código fuente de Chatwoot) — primer intento real conviene testearlo con Postman/curl antes de cablear el composer. |
| A4 | **FE render** (`MessageBubble` por-tipo + lightbox) | Consume A2 (y de yapa A3, ya que un mensaje saliente con adjunto pasa por el mismo `ListMessages`). Se puede arrancar en paralelo con A3 usando un mock del DTO mientras A2 cierra. |
| A5 | **FE composer** (picker + preview + progreso) | Depende de A3 (necesita el endpoint de envío real). Último porque es la pieza de más esfuerzo de UX nueva (preview, progreso) sin patrón exacto reusable. |

Esto responde directamente la pregunta del brief ("¿recibir primero o enviar primero?"): **recibir primero (A2 antes que A3)** — no por preferencia arbitraria, sino porque A2 es el único paso que se puede validar con tráfico de producción real sin haber escrito una sola línea de FE ni haber probado el multipart de envío contra Chatwoot.

---

## Decisiones abiertas (para `sdd-propose`/`sdd-design`)

1. **Descarga entrante: SYNC vs ASYNC** ← la más importante.
   - **Recomendación: ASYNC** (fire-and-forget inmediato + scheduler de reintento, ver Área 3). El webhook sigue respondiendo 200 en milisegundos sin importar el peso del adjunto; el patrón `setInterval+inFlight+DistributedLock` ya existe 6+ veces en el repo (`RadiusAuthIngestScheduler.ts`, `TaskAutocompleteScheduler.ts`, etc.) — cero infraestructura nueva, solo un clon más.
   - Alternativa SYNC (descargar inline dentro del webhook, antes de responder 200): más simple de escribir, pero arriesga exactamente la clase de bug que el repo ya sweepeó dos veces este año (handlers async lentos → 504/reintentos de webhook) — la commit history del propio repo (`77a6fc97`, sweep fase 2 de 504 latente) es evidencia directa de por qué esto es una mala idea acá.

2. **Límites de tamaño/tipo por canal WhatsApp** — el `MAX_FILE_BYTES=10MiB` de `taskAttachments.routes.ts:17` NO sirve tal cual: límites reales de Meta/WhatsApp Business API son ~5MB imagen, ~16MB video, ~16MB audio, ~100MB documento. **Gotcha técnico real**: `multer` limita por `limits.fileSize` a nivel de MIDDLEWARE, UN SOLO número — no puede aplicar un techo distinto por campo/tipo en la misma instancia. Hay que: (a) configurar multer con el techo MÁS ALTO (100MB, documento) para no rechazar de entrada un archivo válido, y (b) re-validar el tamaño REAL por `fileType` a nivel de use case DESPUÉS de que multer lo aceptó (mismo lugar donde ya se valida magic-bytes/mimetype, `AttachPhotosToTask.ts` líneas 90-116, pero con un límite parametrizado por tipo en vez de un único `MAX_IMAGE_PIXELS`). Confirmar con el arquitecto si se toman los límites de Meta tal cual o algo más conservador para no llenar MinIO de documentos de 100MB.

3. **Media saliente: ¿a MinIO también o solo a Chatwoot?**
   - Recomendación: **también a MinIO**, mismo criterio de autonomía del mirror que motivó la decisión general de "MinIO propio" — si Chatwoot algún día deja de servir el binario (retención, migración, etc.), un mensaje SALIENTE nuestro no debería depender de que Chatwoot lo siga alojando. Costo marginal bajo: el BE YA tiene el buffer en memoria (multer) para reenviarlo a Chatwoot, subirlo a MinIO en el mismo paso es una llamada extra a `fileStorage.save()`, no una descarga adicional.

4. **Thumbnails** — Chatwoot da `thumb_url` SOLO para `image` (`chatwoot-media-payload.md` línea 19: `thumb_url` vacío `''` para el resto). Para fase A:
   - Imagen: reusar el pipeline YA existente (`ImageProcessor.process`, thumbnail 400px/JPEG70, `AttachPhotosToTask.ts:144-162`) sobre el binario YA descargado a MinIO — NO usar el `thumb_url` de Chatwoot directamente para no crear una dependencia de red externa en el render del thread (rompe el "mirror autónomo").
   - Video/audio: **sin thumbnail generado en fase A** (no hay `ffmpeg`/`ffprobe` en el repo — meterlo es una dependencia nueva no trivial, decisión de arquitectura aparte). El FE renderiza `<video controls>`/`<audio controls>` nativo, que ya muestra su propio primer frame/ícono sin necesitar un thumb del BE. Revisar en una fase posterior si vale la pena.

5. **Placeholder mientras la media se descarga (async, `status='pending'`)** — el bubble debe pintar algo razonable ANTES de que el download job termine (el polling del thread puede traer el mensaje con el adjunto todavía `pending`). Recomendado: un placeholder simple ("Descargando adjunto…", ícono genérico) que el próximo poll reemplaza automáticamente cuando `status` pasa a `downloaded` — mismo mecanismo de refresco que ya usa el thread para mensajes nuevos (`THREAD-1`), sin lógica nueva de sincronización.

6. **Bucket/key-prefix de MinIO para chat** — `FileStorage`/`MinioFileStorage` son agnósticos de bucket (Área 1); dos caminos:
   - (a) **Reusar la misma instancia/bucket** (`task-photos` o renombrarlo a algo más genérico) con prefijo de key `messaging/{conversationId}/{attachmentId}.{ext}` — cero config nueva, más rápido de shippear.
   - (b) **Bucket separado** (`MINIO_BUCKET_MESSAGING`, segunda instancia de `MinioFileStorage`) — mejor aislamiento si en el futuro se quiere una política de retención/cuota distinta para chat vs tareas.
   - Recomendación tentativa: (a) para fase A (YAGNI), dejar (b) para cuando haya una razón concreta de negocio (ej. borrar media de chat a los N días, cosa que tareas no hace).

---

## Archivos relevantes (para referencia de `sdd-propose`/`sdd-design`)

**BE — patrón a clonar:**
- `src/domain/ports/FileStorage.ts`
- `src/infrastructure/adapters/minio/MinioFileStorage.ts`
- `src/infrastructure/adapters/in-memory/InMemoryFileStorage.ts`
- `src/infrastructure/http/routes/taskAttachments.routes.ts`
- `src/application/use-cases/AttachPhotosToTask.ts`
- `src/domain/errors/taskAttachment.ts`
- `src/application/dto/taskAttachment.dto.ts`
- `prisma/schema.prisma` (`model ScheduledTaskAttachment` líneas 1489-1503, `model ChatMessage`/`Conversation` líneas 2757-2811)
- `src/infrastructure/config.ts:321-335` (env MINIO_*)

**BE — patrón scheduler async (para la descarga):**
- `src/infrastructure/scheduling/BackfillScheduler.ts` (fire-and-forget on-demand)
- `src/infrastructure/scheduling/RadiusAuthIngestScheduler.ts` (setInterval + inFlight + DistributedLock + feature flag, molde exacto de recurring retry)
- `src/infrastructure/scheduling/TaskAutocompleteScheduler.ts` (mismo molde, con `triggerNow()` manual)
- `src/domain/ports/DistributedLock.ts` (advisory lock)

**BE — messaging (a extender):**
- `src/application/use-cases/messaging/ReceiveChatwootWebhook.ts`
- `src/application/use-cases/messaging/SendMessage.ts`
- `src/domain/ports/ChatwootGateway.ts`
- `src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts`
- `src/domain/ports/ChatMessageRepository.ts`
- `src/application/dto/messaging.ts`
- `src/infrastructure/http/routes/messaging.routes.ts`

**FE — patrón a clonar:**
- `ipnext-frontend/src/pages/scheduling/SchedulingTaskDetailPage/components/TaskPhotosGallery.tsx`
- `ipnext-frontend/src/api/taskAttachments.api.ts`
- `ipnext-frontend/src/hooks/useTaskAttachments.ts`
- `ipnext-frontend/src/utils/mapUploadError.ts`

**FE — messaging (a extender):**
- `ipnext-frontend/src/pages/whatsapp/WhatsappInboxPage/components/Composer.tsx`
- `ipnext-frontend/src/pages/whatsapp/WhatsappInboxPage/components/MessageBubble.tsx`
- `ipnext-frontend/src/types/whatsapp.ts`
- `ipnext-frontend/src/api/whatsapp.api.ts`
- `ipnext-frontend/src/hooks/useWhatsapp.ts`

**Fuentes ya verificadas (no re-investigadas):**
- `chatwoot-media-payload.md` (scratchpad) — shape real del webhook `data.attachments[]`.
- `openspec/changes/messaging-inbox-v2/explore.md` — Grupo A del explore general de F1.5 (contexto, faseo global, decisiones abiertas iniciales).
