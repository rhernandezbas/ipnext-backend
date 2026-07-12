# Proposal — messaging-inbox-v2-media · F1.5 fase A · **TANDA 1: RECIBIR MEDIA**

> Alcance de ESTE proposal: **SOLO RECIBIR** media (fotos/videos/audios/archivos que
> manda el cliente por WhatsApp → aparecen en el thread). **ENVIAR** media desde el
> composer es la **Tanda 2** y NO se toca acá, salvo dejar el modelo listo para que
> Tanda 2 lo reuse tal cual.
>
> Base ya en prod (no se re-diseña): F1 (inbox texto) + F1.5-B (contexto rico). El
> payload real de Chatwoot con adjuntos fue **verificado en vivo** contra el código
> fuente de Chatwoot v4.13.0 (`scratchpad/chatwoot-media-payload.md`). El patrón de
> binarios a clonar (**task-photos**) está maduro y con hardening real.
>
> Decisiones de arquitectura **YA CONFIRMADAS** por el arquitecto (no se re-litigan
> acá, se documentan con su justificación en §Decisiones tomadas):
> 1. Storage = **MinIO propio**, reusando `FileStorage` + `MinioFileStorage` sin
>    cambios, con prefijo de key `messaging/{conversationId}/{attachmentId}.ext`,
>    **bucket COMPARTIDO** con task-photos (YAGNI, sin bucket nuevo).
> 2. Descarga entrante = **ASYNC**: el webhook crea la fila `pending` en sync (200 al
>    toque) + dispara la descarga fire-and-forget + un **scheduler de reintento**
>    clonando el patrón existente (`setInterval` + `inFlight` + `DistributedLock` +
>    feature flag). **CERO infra nueva** (nada de Bull/Redis).
> 3. Límites: imagen 5MB, video/audio 16MB, documento 100MB. `multer` un techo
>    (100MB) + **re-validar por `fileType` en el use-case**.
> 4. Video/audio = **player nativo** (no hay ffmpeg → sin thumbnail generado en A).
>    Imágenes usan el `thumb_url` que Chatwoot ya generó (bajado a NUESTRO MinIO, ver
>    Decisión 4 — no se expone la URL de Chatwoot al FE).
> 5. **Placeholder "descargando…"** mientras `status='pending'`, resuelto por el
>    polling que el thread YA usa (THREAD-1) — cero lógica nueva de sincronización.

---

## Why

Hoy un cliente manda una foto del comprobante de pago, del cablemodem, del error en
pantalla — y **el mensaje llega vacío al thread**. `ChatMessage` es texto puro
(`content: String`, sin ningún campo de adjunto); `ReceiveChatwootWebhook` ni siquiera
declara `attachments` en su payload, así que **el binario se descarta silenciosamente**.
El agente ve una burbuja vacía y tiene que pedirle al cliente que reenvíe por otro
canal. Es una pérdida de información real, todos los días (comprobantes, fotos de
antena/instalación — casos de uso IPNEXT del día a día, ya señalados en el explore de
F1.5 Grupo A).

La buena noticia: **no hay que inventar nada de infraestructura**. El repo ya tiene un
patrón completo, maduro y con hardening (task-photos) para subir/servir binarios por
`FileStorage`/`MinioFileStorage`, y un patrón consolidado 6+ veces
(`RadiusAuthIngestScheduler`, `TaskAutocompleteScheduler`, `BackfillScheduler`) para
trabajo diferido con `setInterval` + `DistributedLock` + feature flag. Esta tanda
**conecta esas dos piezas ya probadas** al pipeline de messaging, sin agregar
dependencias. Y arranca por RECIBIR porque es el único paso que se puede validar con
**tráfico de producción real** (Chatwoot ya nos manda adjuntos hoy, los tiramos) sin
escribir una línea de FE ni probar el multipart de envío.

---

## What changes

### Backend

1. **Nuevo modelo Prisma `ChatMessageAttachment`** (1:N con `ChatMessage`) + migración
   **ADITIVA** (solo `CREATE TABLE` + índices + FK, clon del molde de
   `20260823000000_add_scheduled_task_attachment`). Se agrega la relación inversa
   `attachments ChatMessageAttachment[]` a `ChatMessage` (aditivo, sin tocar columnas
   existentes). Índice por `status` para el scheduler de reintento. Campos exactos en
   §Contrato.

2. **Nuevo port `ChatMessageAttachmentRepository`** (`domain/ports/`):
   `upsertByChatwootAttachmentId` (idempotente, **no pisa** una fila ya `downloaded`),
   `listByMessageIds` (para el mapper, sin N+1 vía `include`), `findById`,
   `listRetriable({ maxAttempts, limit })` (`status IN ('pending','failed') AND
   downloadAttempts < max`), `markDownloaded`, `markFailed`. Adapters `Prisma*` e
   `InMemory*` (este último para tests, mismo criterio que el resto del repo).

3. **Captura en el webhook (SYNC, rápido)**: `ChatwootWebhookPayload` gana
   `attachments?: RawAttachment[]`; `ReceiveChatwootWebhook.handleMessageCreated`, en la
   MISMA rama donde ya persiste el `ChatMessage` (`direction !== null && !isPrivate &&
   payload.id !== undefined`), crea **una fila `ChatMessageAttachment` por adjunto**
   binario (`fileType ∈ {image,audio,video,file}` — `location`/`contact`/`fallback`/
   `embed` se ignoran en Tanda 1) con `status='pending'`, `sourceUrl`, `thumbSourceUrl?`
   y los metadatos que Chatwoot ya reporta. **No descarga el binario acá.** El webhook
   sigue respondiendo 200 en milisegundos, sin importar cuántos ni cuán pesados sean.

4. **Nuevo use case `DownloadChatMessageAttachment`** (`application/use-cases/messaging/`):
   descarga de Chatwoot (`download_url`/`data_url` siguiendo el 301) → **valida tamaño
   real por `fileType`** → `FileStorage.save({ key: messaging/{conversationId}/{id}.ext
   })` → (si `image`) baja también `thumbSourceUrl` a `thumbStorageKey` →
   `markDownloaded`. En catch → `markFailed` (`downloadAttempts+1`, `lastError`). Un
   solo lugar, invocado por dos disparadores (fire-and-forget + scheduler).

5. **Descarga desde Chatwoot en el gateway**: nuevo método
   `ChatwootGateway.downloadAttachment(url): Promise<{ buffer; contentType }>` (+ impl
   en `HttpChatwootGateway`) — encapsula el seguimiento del 301 y la cuestión del
   `api_access_token` DENTRO del gateway (no filtra ese conocimiento al use case). Ver
   Decisión abierta A (auth/301) y B (buffer vs stream para 100MB).

6. **Fire-and-forget + scheduler de reintento**:
   - Port `ChatMediaDownloadTrigger { requestDownload(attachmentId): void }` (domain),
     inyectado en `ReceiveChatwootWebhook` (opcional). Su impl infra hace
     `void downloadUseCase.execute(id)` — baja latencia (el adjunto queda `downloaded`
     segundos después del 200, sin que el webhook lo espere). Mantiene DIP (el use case
     no conoce al scheduler).
   - `ChatMediaDownloadScheduler` — **clon EXACTO** de `RadiusAuthIngestScheduler`
     (`setInterval` + `inFlight` + `DistributedLock('chat-media-download')` + feature
     flag `chat-media-download`, dark by default). Cada N barre `listRetriable(...)` y
     reintenta. Cubre: el proceso se reinició antes de terminar el fire-and-forget,
     Chatwoot caído en el intento 1, o el 301 falló transitoriamente. Wireado en
     `app.ts`/bootstrap junto a los demás schedulers.

7. **DTO**: `ChatMessageDto` gana `attachments: ChatMessageAttachmentDto[]`. El
   `ChatMessageRecord` (port) lleva las filas de adjunto (Prisma `include`), y
   `toChatMessageDto` las mapea. **NUNCA se expone `sourceUrl`/`storageKey`** — se
   expone `url`/`thumbUrl` como rutas relativas al endpoint BE-proxy (mismo patrón que
   `ScheduledTaskAttachmentDto`). Mismo tratamiento en el path de fetch-on-open:
   `RawChatwootMessage`/`ChatwootMessageDto`/`toMessageDto` (`HttpChatwootGateway`)
   capturan también `attachments` para que `GetConversation.syncFromChatwoot` backfillee
   con paridad (mismo dato, otro canal — la GET API de Chatwoot anida los attachments
   igual que el webhook, verificado en el fuente).

8. **Endpoint de servido** (clon de `taskAttachments.routes`):
   `GET /api/messaging/attachments/:id/file?variant=original|thumb`, gated
   `messaging:read`, `Content-Disposition` RFC 5987 seguro (clon del helper
   `contentDisposition`), `next(err)` en todo handler async (ROB-1/lección 504). Nuevo
   use case `GetChatAttachmentFile({ attachmentId, variant })`: lee `storageKey` de la
   fila, `fileStorage.get(key)`, devuelve `{ buffer, mimeType, filename }`. Si
   `status !== 'downloaded'` (o `storageKey == null`) → `AttachmentNotReadyError` (409);
   si no existe → `AttachmentNotFoundError` (404); `variant=thumb` sin `thumbStorageKey`
   → cae al original (mismo fallback que `ScheduledTaskAttachmentDto`). El binario real
   (MinIO) queda privado detrás del BE.

9. **Errores tipados** (`domain/errors/chatAttachment.ts`, clon de `taskAttachment.ts`):
   `AttachmentTooLargeError` (413, por `fileType`), `UnsupportedAttachmentTypeError`
   (415), `ChatAttachmentNotFoundError` (404), `ChatAttachmentNotReadyError` (409),
   reusar `StorageNotConfiguredError` (503, degrada sin tumbar el boot).

10. **Wiring** en `app.ts`: instanciar el repo, el use case de descarga, el trigger, el
    scheduler y el `GetChatAttachmentFile`, y pasarlos al router de messaging + al array
    de schedulers del bootstrap. La instancia de `MinioFileStorage` es la MISMA que
    task-photos (bucket compartido).

### Frontend (solo se describe — el detalle es `sdd-design`, otra fase)

`MessageBubble.tsx` deja de ser solo `<span>{message.content}</span>` y renderiza,
**además** del texto, una rama por `attachment.fileType`:

- **`image`** → `<img>` (usa `thumbUrl`, o `url` si no hay thumb) + **lightbox reusado
  100% de `TaskPhotosGallery`** (focus-trap + Escape + portal + fallback de imagen rota).
- **`video`** → `<video controls>` nativo (`url`) — sin poster generado (no hay ffmpeg).
- **`audio`** → `<audio controls>` nativo (`url`).
- **`file`** → ícono (SVG, nunca emoji — regla del repo) + `filename` + tamaño legible +
  link de descarga (`url`, el BE ya manda `Content-Disposition`).
- **`status='pending'`** → placeholder "Descargando adjunto…" (ícono genérico +
  spinner). El siguiente poll del thread (THREAD-1) lo reemplaza solo cuando pasa a
  `downloaded`.
- **`status='failed'`** → estado de error ("No se pudo descargar el adjunto").
- **Mensaje solo-attachment** (`content === ''`): NO pintar un `<span></span>` fantasma
  — renderizar únicamente el/los adjunto(s) (residuo ya anotado por el review adversarial
  de F1).

`types/whatsapp.ts` gana `attachments: WhatsappChatMessageAttachment[]` (espejo del
`ChatMessageAttachmentDto`, con `url`/`thumbUrl` BE-proxy, **nunca** `sourceUrl`).

---

## Impact

| Área | Cambio | Riesgo de regresión |
|---|---|---|
| `prisma/schema.prisma` (`model ChatMessageAttachment` + relación en `ChatMessage`) | **NUEVO** (aditivo) | ninguno (tabla nueva, FK cascade) |
| `prisma/migrations/…_add_chat_message_attachment` | **NUEVA** (CREATE TABLE + índices + FK) | ninguno (aditiva) |
| `domain/ports/ChatMessageAttachmentRepository.ts` (+ Prisma/InMemory adapters) | **NUEVO** | ninguno |
| `application/use-cases/messaging/ReceiveChatwootWebhook.ts` | +captura de `attachments[]` → filas `pending` | bajo (rama nueva dentro del branch ya existente; si falla, no persiste el binario pero no rompe el texto) |
| `application/use-cases/messaging/DownloadChatMessageAttachment.ts` | **NUEVO** | ninguno |
| `application/use-cases/messaging/GetChatAttachmentFile.ts` | **NUEVO** | ninguno |
| `domain/ports/ChatwootGateway.ts` + `HttpChatwootGateway.ts` | +`downloadAttachment` (aditivo) | bajo |
| `domain/ports/ChatMediaDownloadTrigger.ts` + `infrastructure/scheduling/ChatMediaDownloadScheduler.ts` | **NUEVO** (clon de scheduler existente) | ninguno (dark por feature flag) |
| `application/dto/messaging.ts` (`ChatMessageDto.attachments` + sub-DTO + mapper) | aditivo | bajo (campo nuevo; los consumidores actuales ignoran el array) |
| `HttpChatwootGateway` `RawChatwootMessage`/`toMessageDto` | +`attachments` en fetch-on-open | bajo |
| `infrastructure/http/routes/messaging.routes.ts` | +1 ruta GET `attachments/:id/file` | bajo (path disjunto, no toca las existentes) |
| `domain/errors/chatAttachment.ts` | **NUEVO** (clon de `taskAttachment.ts`) | ninguno |
| `infrastructure/http/app.ts` | +wiring (reusa la instancia MinIO de task-photos) | bajo |
| **SendMessage / composer / envío a Chatwoot** | **sin cambios** (es Tanda 2) | — |
| FE `MessageBubble.tsx` / `types/whatsapp.ts` | render por-tipo (otra fase) | contenido en el FE |

Piezas REUTILIZADAS sin modificar: `FileStorage`, `MinioFileStorage`,
`InMemoryFileStorage`, `DistributedLock`, `contentDisposition` (patrón), el molde de
scheduler, el lightbox de `TaskPhotosGallery`.

---

## Contrato propuesto

### Modelo Prisma `ChatMessageAttachment` (campo por campo)

```prisma
model ChatMessageAttachment {
  id                   String      @id @default(uuid())
  messageId            String
  message              ChatMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
  chatwootAttachmentId Int         // id del adjunto en Chatwoot — idempotencia (mismo criterio que chatwootMessageId)
  fileType             String      // 'image' | 'audio' | 'video' | 'file' (String plano, NO enum Prisma — mismo criterio que ChatMessage.direction / Conversation.status)
  contentType          String      // MIME real reportado por Chatwoot (content_type), ej. image/jpeg, video/mp4
  filename             String?     // Chatwoot no siempre lo da; si falta, derivar de la extension
  sizeBytes            Int?        // file_size de Chatwoot (nombre alineado con ScheduledTaskAttachment; se expone como fileSize en el DTO)
  width                Int?        // solo image/video
  height               Int?        // solo image/video
  storageKey           String?     // NULL mientras status='pending'; se llena al bajar OK a MinIO (messaging/{conversationId}/{id}.ext)
  thumbStorageKey      String?     // solo image; el thumb_url de Chatwoot bajado a MinIO. NULL para audio/video/file
  sourceUrl            String      // download_url/data_url de Chatwoot — lo usa el job de descarga y los reintentos
  thumbSourceUrl       String?     // thumb_url de Chatwoot (solo image) — de dónde baja el thumbnail el job
  status               String      @default("pending") // 'pending' | 'downloaded' | 'failed'
  downloadAttempts     Int         @default(0)
  lastError            String?     // último error del download job (debug)
  createdAt            DateTime    @default(now())
  updatedAt            DateTime    @updatedAt

  @@unique([chatwootAttachmentId])  // idempotencia: reprocesar el mismo message_created no duplica
  @@index([messageId])              // el mapper trae los adjuntos de un mensaje
  @@index([status])                 // el scheduler barre por status='pending'/'failed'
}
```

Y en `model ChatMessage`, aditivo: `attachments ChatMessageAttachment[]`.

**`status`/`downloadAttempts`/`lastError`/`sourceUrl`/`thumbSourceUrl`** son el único
agregado real respecto a `ScheduledTaskAttachment` — necesarios porque acá la escritura
del binario **no es síncrona** con la creación de la fila (descarga async). El resto
espeja el molde ya aprobado.

### Flujo entrante (webhook → pending → job → MinIO → downloaded)

```
1. [SYNC, dentro del webhook]  message_created con attachments[]
   └─ ReceiveChatwootWebhook: upsert ChatMessage (como hoy)
      └─ por cada adjunto binario: upsertByChatwootAttachmentId({
           messageId, chatwootAttachmentId, fileType, contentType, filename,
           sizeBytes, width, height, sourceUrl=download_url??data_url,
           thumbSourceUrl=thumb_url (si image), status:'pending' })
      └─ trigger.requestDownload(id)   // fire-and-forget, NO se espera
   └─ res 200 (milisegundos)           // el webhook NUNCA descarga el binario

2. [ASYNC, fire-and-forget]  DownloadChatMessageAttachment.execute(id)
   └─ gateway.downloadAttachment(sourceUrl)   // sigue el 301
   └─ valida sizeBytes real por fileType (5/16/100MB)  → AttachmentTooLargeError si excede
   └─ fileStorage.save({ key: messaging/{conversationId}/{id}.ext, buffer, mimeType })
   └─ si image: gateway.downloadAttachment(thumbSourceUrl) → save thumbStorageKey
   └─ markDownloaded({ storageKey, thumbStorageKey })   // status='downloaded'
   catch → markFailed({ downloadAttempts+1, lastError })

3. [ASYNC, scheduler cada N min]  ChatMediaDownloadScheduler
   └─ listRetriable({ maxAttempts, limit }) → por cada uno: DownloadChatMessageAttachment.execute(id)
      (cubre reinicio del proceso, Chatwoot caído en intento 1, 301 transitorio)

4. [POLL del thread]  el próximo GET .../messages trae el attachment con status ya
   'downloaded' → el FE reemplaza el placeholder por el <img>/<video>/<audio>/link.
```

### DTO — `ChatMessageAttachmentDto`

```ts
export interface ChatMessageAttachmentDto {
  id: string;
  fileType: 'image' | 'audio' | 'video' | 'file';
  contentType: string;
  filename: string | null;
  fileSize: number | null;          // ← sizeBytes del modelo (rename en el wire, mismo criterio que lastMessagePreview→preview)
  width: number | null;
  height: number | null;
  status: 'pending' | 'downloaded' | 'failed';
  url: string;                      // BE-proxy: /api/messaging/attachments/:id/file  (NUNCA la sourceUrl de Chatwoot)
  thumbUrl: string | null;          // BE-proxy: ...?variant=thumb  — null para audio/video/file
}

// ChatMessageDto gana:
//   attachments: ChatMessageAttachmentDto[];
```

Para `pending`/`failed`, `url` igual apunta al endpoint, pero el FE usa `status` para
pintar el placeholder/error **sin** pegarle al endpoint (que devolvería 409 hasta que
esté `downloaded`).

### Endpoint de servido

`GET /api/messaging/attachments/:id/file?variant=original|thumb` — gated `messaging:read`,
clon 1:1 de `GET /api/scheduling/attachments/:id/file`:
- `variant=original` (default) → el binario original desde `storageKey`.
- `variant=thumb` → `thumbStorageKey`, con fallback al original si es null.
- `Content-Type` del `contentType`, `Content-Disposition` RFC 5987 (`inline` para que el
  FE lo muestre; los `file` igual se descargan por el tipo MIME).
- `status !== 'downloaded'` → 409 `ChatAttachmentNotReadyError`; id inexistente → 404.

---

## Decisiones tomadas + justificación

### Decisión 1 — MinIO propio, bucket COMPARTIDO, key con prefijo `messaging/` (confirmada)

Reusar `FileStorage`/`MinioFileStorage` (agnósticos de bucket — la key la genera el use
case) con prefijo `messaging/{conversationId}/{attachmentId}.ext`, en el MISMO bucket
que task-photos. **Justificación**: cero config nueva, cero código de storage nuevo, y
el prefijo ya aísla lógicamente el chat de las fotos de tarea. Un bucket separado
(`MINIO_BUCKET_MESSAGING`) solo se justifica cuando haya una política de retención/cuota
distinta para chat vs tareas — YAGNI hoy, refactor aislado el día que aparezca. **Por
qué MinIO y no passthrough de la URL de Chatwoot**: el mirror queda **autónomo** — si
Chatwoot algún día deja de servir el binario (retención/migración), el thread sigue
mostrando la foto desde NUESTRO storage. Además nunca se expone una URL de Chatwoot al FE.

### Decisión 2 — Descarga ASYNC (fire-and-forget + scheduler), NO síncrona en el webhook (confirmada)

El webhook crea la fila `pending` en sync y responde 200 en milisegundos; el binario se
baja fuera del request. **Justificación dura, con evidencia en el propio repo**:
descargar+re-subir un documento de hasta 100MB ANTES de responder 200 es exactamente la
clase de handler async lento que este backend **ya sweepeó dos veces este año** por 504
latente (`77a6fc97`, sweep fase 2). Mantener el webhook flaco y mover el trabajo pesado a
un job es la lección ya aprendida acá. **Por qué NO una cola externa (Bull/Redis)**: no
existe NADA de colas en el repo; el patrón `setInterval + inFlight + DistributedLock +
feature flag` ya resuelve "reintentar trabajo diferido de forma distribuida" en 6+
features (`RadiusAuthIngestScheduler`, `TaskAutocompleteScheduler`, etc.). Introducir
infra de colas para UNA feature es sobre-ingeniería; si el volumen de media crece,
migrar a una cola real es un refactor futuro que **no toca** el use case de descarga
(solo cambia quién lo dispara). El fire-and-forget baja la latencia del caso feliz; el
scheduler es la red de seguridad (garantía de entrega eventual).

### Decisión 3 — Límites por `fileType`, revalidados en el use-case (confirmada)

`multer` limita por `limits.fileSize` a nivel middleware con **un solo número** — no
puede aplicar un techo distinto por tipo. (Nota: en RECIBIR no hay `multer` en el request
path — la descarga la hace el job; el techo se aplica sobre el `file_size` que reporta
Chatwoot y sobre los bytes realmente bajados.) Se toma el máximo (100MB documento) como
techo duro y se **re-valida el tamaño real por `fileType`** en `DownloadChatMessageAttachment`
(imagen 5MB, video/audio 16MB, documento 100MB), mismo lugar conceptual donde task-photos
valida magic-bytes/dimensiones. Un adjunto que excede su límite → `AttachmentTooLargeError`
(413), fila `failed`, no se sube. (En Tanda 2, cuando el agente ENVÍA, sí se configura
`multer` con el techo de 100MB + la misma revalidación por tipo.)

### Decisión 4 — Thumbnail de imagen = el `thumb_url` de Chatwoot, bajado a NUESTRO MinIO (confirmada)

Chatwoot ya genera un `thumb_url` para `image` (`''` para el resto). En vez de correr
`ImageProcessor.process` en el job async (jimp sobre el binario ya bajado), el job baja
el `thumb_url` de Chatwoot a `thumbStorageKey`. **Justificación**: más barato (sin
procesamiento de imagen en el job), y **sigue siendo autónomo** porque el thumb vive en
NUESTRO MinIO y se sirve por NUESTRO endpoint (`?variant=thumb`) — el FE nunca toca la
URL de Chatwoot. Video/audio: **sin thumbnail** en fase A (no hay ffmpeg/ffprobe; meterlo
es una dependencia nueva y una decisión de arquitectura aparte). El `<video controls>`/
`<audio controls>` nativo ya muestra su propio primer-frame/ícono. (Alternativa evaluada
y descartada por costo: generar el thumb con `ImageProcessor` — queda como opción si
algún día Chatwoot no manda `thumb_url` para algún caso; ver Decisión abierta C.)

### Decisión 5 — Idempotencia por `chatwootAttachmentId`, sin pisar lo ya bajado (confirmada por patrón)

`@@unique([chatwootAttachmentId])` (mismo criterio que `chatwootMessageId`). El upsert es
insert-if-new: si la fila ya está `downloaded`, un reprocesamiento del mismo
`message_created` **no** la vuelve a `pending` ni le borra el `storageKey`. Cubre los
reintentos de webhook de Chatwoot sin re-descargar.

---

## Riesgos

- **504 por descarga lenta** → **mitigado por diseño** (Decisión 2): el webhook nunca
  descarga en el request path; solo escribe una fila `pending` en Postgres (barato).
- **El `data_url` de Chatwoot hace 301** (a la blob de ActiveStorage). El
  `downloadAttachment` del gateway debe seguir el redirect. El scratchpad documenta que
  existe `download_url` (blob.url) **justo para consumidores externos donde el 301
  falla** → se captura `download_url` como `sourceUrl` primario y se cae a `data_url`
  (con follow-redirect) si no viene. Ver Decisión abierta A.
- **¿La descarga necesita el `api_access_token`?** El `data_url` self-hosted normalmente
  redirige a una URL firmada del storage que **no** requiere el token (la firma es la
  auth). Riesgo secundario: axios por defecto **reenvía los headers en el redirect** — el
  `api_access_token` podría filtrarse al host de la blob si es cross-host. El gateway debe
  **stripear el token en redirects cross-host**. Ver Decisión abierta A (a confirmar en
  vivo contra `.37`).
- **100MB en memoria vs stream**: `FileStorage.save` toma un `Buffer` → un documento de
  100MB = 100MB en RAM en el job. Varias descargas concurrentes = presión de memoria. El
  scheduler ya **serializa** (`inFlight` + `DistributedLock` = una corrida a la vez); el
  fire-and-forget podría no estar acotado. Ver Decisión abierta B (buffer serializado vs
  agregar `putStream` al port).
- **MINIO_* no seteadas en prod hoy** (config.ts §321-322: la integración es opt-in y NO
  fail-fast). Con el feature flag `chat-media-download` **dark by default**, los adjuntos
  quedan `pending` y degradan limpio (`StorageNotConfiguredError` → `failed`, sin tumbar
  el boot). **Prerequisito de prod**: setear `MINIO_*` y prender el flag antes de esperar
  descargas. Se documenta como gate de rollout, no como bug.
- **Crecimiento de storage sin retención** para media de chat (a diferencia de tareas,
  que tampoco borra) — YAGNI hoy, se anota para una futura política de retención (motivo
  eventual para el bucket separado de Decisión 1).
- **RBAC de servido**: `messaging:read` es un gate global (sin ACL por-conversación en
  F1) → cualquier usuario con `messaging:read` puede pedir cualquier attachment por id.
  Es **consistente** con el resto de messaging (no introduce un leak nuevo), pero se
  deja anotado por si el arquitecto quiere scoping por-conversación más adelante.

---

## Fuera de scope (Tanda 2 / fases futuras)

- **ENVIAR media desde el composer** (multipart → Chatwoot `attachments[]`, preview,
  progreso de subida, `SendMessage` extendido, `HttpChatwootGateway.sendMessage` con
  archivos, picker en `Composer.tsx`) → **TANDA 2**. El modelo `ChatMessageAttachment`
  queda listo para que Tanda 2 lo reuse (un mensaje saliente con adjunto nace
  `downloaded` desde el vamos, sin pasar por el job).
- **Thumbnails de video/audio** (poster-frame) → requiere ffmpeg/ffprobe, dependencia y
  decisión de arquitectura aparte.
- **Edición/borrado de media** desde Prominense.
- **Tipos no-binarios** de Chatwoot (`location`, `contact`, `fallback`, `embed`) — no
  tienen binario descargable; se ignoran en Tanda 1.
- **`transcribed_text` de audios** (Chatwoot lo trae) — nice-to-have como caption/
  accesibilidad; no en Tanda 1.
- **Preview del inbox con ícono de adjunto** (ej. "📎 Imagen" en `lastMessagePreview`
  para mensajes solo-attachment) — mejora cosmética, no en Tanda 1.

---

## Decisiones abiertas — necesitan OK del arquitecto antes del spec

- **A. Descarga de Chatwoot (301 + auth).** ¿`sourceUrl` = `download_url` primario con
  fallback a `data_url`+follow-redirect (recomendado, es lo que el fuente de Chatwoot
  sugiere para consumidores externos)? ¿Confirmamos en vivo contra `.37` si el binary
  necesita `api_access_token`, y stripeamos el token en redirects cross-host para no
  filtrarlo a la blob? (Recomendación: sí a ambos.)
- **B. Buffer vs stream para 100MB.** ¿Tanda 1 se queda con `FileStorage.save(Buffer)` +
  descargas serializadas por el `DistributedLock`/`inFlight` (recomendado, cero cambios
  al port, memoria acotada a 1 descarga a la vez), o agregamos `putStream` al
  `FileStorage` ya para no tener 100MB en RAM ni siquiera una vez? (Recomendación:
  buffer serializado ahora; `putStream` como refactor si el perfil de memoria molesta.)
- **C. Thumbnail de imagen.** Confirmás Decisión 4 (bajar el `thumb_url` de Chatwoot a
  MinIO, sin `ImageProcessor`) — recomendado — ¿o preferís generar el thumb localmente
  con el `ImageProcessor` que ya existe (más autónomo aún, pero corre jimp en el job)?
- **D. Ruta del endpoint.** ¿`GET /api/messaging/attachments/:id/file?variant=…`
  (recomendado, clon exacto de taskAttachments) o el `GET /api/messaging/attachments/:id`
  más pelado del brief? (Es un detalle de forma; el `/file?variant=` reusa el helper y el
  patrón tal cual.)
- **E. Naming `sizeBytes` vs `fileSize`.** El modelo Prisma usa `sizeBytes` (idéntico a
  `ScheduledTaskAttachment`, convención del repo) y el DTO expone `fileSize` (brief). Hay
  precedente de rename en el wire (`lastMessagePreview`→`preview`, messaging.ts:12-13).
  ¿OK, o querés `fileSize` también en la columna por consistencia con el brief?
- **F. Intervalo + MAX intentos del scheduler.** Propuesta: barrido cada ~2 min,
  `downloadAttempts < 5`, con backoff implícito por el intervalo. ¿Valores OK?
