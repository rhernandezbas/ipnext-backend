# Proposal — messaging-inbox-v2-media · F1.5 fase A · **TANDA 2: ENVIAR MEDIA**

> Alcance de ESTE proposal: **SOLO ENVIAR** media desde el composer (el agente adjunta
> fotos/videos/audios/archivos → van a WhatsApp vía Chatwoot). **RECIBIR** media es la
> **Tanda 1** (YA en prod/repo) y NO se re-diseña acá: esta tanda **reusa su modelo, sus
> puertos, su storage y su scheduler tal cual** — el único código nuevo real es el
> "camino de subida" (multipart FE → BE → Chatwoot + espejo directo en MinIO).
>
> Base ya en repo (Tanda 1, no se re-litiga): `ChatMessageAttachment` (1:N con
> `ChatMessage`, `status` pending/downloaded/failed, `storageKey`, `sourceUrl`,
> `downloadAttempts`…), `FileStorage`/`MinioFileStorage` (bucket compartido, prefijo
> `messaging/{conversationId}/{id}.ext`), `ChatMessageAttachmentRepository`
> (`upsertByChatwootAttachmentId` que **NO revierte** una fila ya `downloaded`,
> `markDownloaded`, `markFailed`, `listRetriable`), `ChatMediaDownloadScheduler`
> (reintento async), el endpoint `GET /api/messaging/attachments/:id/file`, el DTO
> `ChatMessageAttachmentDto` + `toChatMessageAttachmentDto`, y `ChatMessageDto.attachments`
> con `toChatMessageDto(record, attachments)`.
>
> Envío a Chatwoot **verificado en vivo** (`scratchpad/chatwoot-media-payload.md`, contra
> el fuente de Chatwoot v4.13.0): `POST /api/v1/accounts/{acc}/conversations/{conv}/messages`
> **multipart/form-data** con `attachments[]` (archivos) + `content` + `message_type`.
> `Messages::MessageBuilder#process_attachments` acepta cada `attachments[]` como
> `UploadedFile` (multipart) o `signed_id` — usamos **multipart con los buffers**.

---

## Why

Hoy el composer solo manda texto (`SendMessage(conversationId, content)` → JSON POST a
Chatwoot). El agente **no puede** responderle al cliente con una foto del plan, un PDF de
la factura, el instructivo de configuración, un video de "así se resetea el equipo". Tiene
que salir del panel y mandarlo por otro canal — exactamente la misma pérdida de contexto
que Tanda 1 arregló para el sentido entrante, pero al revés.

La buena noticia (idéntica a Tanda 1): **no hay que inventar infraestructura**. El modelo
`ChatMessageAttachment` ya está pensado para outbound — un mensaje saliente con adjunto
**nace `downloaded`** (el binario ya lo tiene el BE, no pasa por el job de descarga). El
storage, el DTO, el endpoint de servido y hasta el scheduler de reintento de Tanda 1 se
reusan **sin tocar una línea**. Esta tanda conecta el camino de **subida**: multer en el
POST existente → `HttpChatwootGateway.sendMessage` extendido a multipart → guardado
directo en MinIO → espejo del `ChatMessage` outbound + sus attachments. Y — clave — el
caso de falla degrada **hacia el mismo camino async de Tanda 1** (ver Decisión 1), así que
no se agrega ni una pieza de compensación nueva.

---

## What changes

### Backend

1. **Gateway — `ChatwootGateway.sendMessage` extendido a multipart**
   (`domain/ports/ChatwootGateway.ts` + `HttpChatwootGateway.ts`). Firma nueva
   (aditiva, retrocompatible): `sendMessage(chatwootConversationId, content, files?)`
   donde `files?: OutboundAttachmentFile[]` (`{ buffer, filename, contentType }`).
   - **Sin `files`** → se conserva el camino actual **JSON** (`{ content, message_type:
     'outgoing' }`) — cero regresión sobre el envío de texto ya en prod.
   - **Con `files`** → **multipart/form-data**: se arma un `FormData` (paquete
     `form-data`, ver Decisión 6) con `form.append('content', content)`,
     `form.append('message_type', 'outgoing')` y **un `form.append('attachments[]',
     buffer, { filename, contentType })` por archivo**; `this.http.post(url, form, {
     headers: form.getHeaders(), timeout, maxBodyLength, maxContentLength })`. Devuelve el
     `ChatwootMessageDto` mapeado por `toMessageDto` — que **ya incluye `attachments`**
     (Tanda 1, MEDIA-1 fetch-on-open parity): la respuesta del POST trae el mensaje creado
     con sus `attachments[]` (`id` = `chatwootAttachmentId`, `data_url` = `sourceUrl`,
     `content_type`, `file_size`, `thumb_url`…). **Ese es el pegamento que hace idempotente
     todo lo de abajo.**

2. **Use case — `SendMessage` extendido** (`application/use-cases/messaging/SendMessage.ts`).
   Firma nueva aditiva: `execute(conversationId, content, files?)`. Gana una dependencia:
   el `ChatMessageAttachmentRepository` (el mismo que Tanda 1) + el `FileStorage` (la misma
   instancia `taskPhotoStorage`). Orden de guardas **pinneado** (extiende el de SEND-1/2/3):

   ```
   1. conversation = findById(id)            → 404 ConversationNotFoundError
   2. if !canReply                            → 422 MessagingWindowExpiredError (sin llamar a Chatwoot)
   3. validar TODO el lote de files UPFRONT   → 415 UnsupportedAttachmentType / 413 AttachmentTooLarge
      (deriva fileType del mimetype: image/* video/* audio/* → resto = 'file';
       revalida sizeBytes por fileType: 5/16/100MB — reusa MAX_BYTES_BY_FILE_TYPE)
      (si UNA falla, NINGUNA se manda — mismo criterio batch que AttachPhotosToTask)
   4. sent = gateway.sendMessage(chatwootConvId, content, files)  → catch ⇒ 503 ChatwootUnavailable
      (Chatwoot es la FUENTE DE VERDAD: si esto falla, NADA se persistió — el mensaje NO salió)
   5. ESPEJO (post-Chatwoot-OK):
      5a. message = messageRepo.upsertByChatwootMessageId({ ...sent, direction:'outbound' })   (idempotente)
      5b. por cada attachment i devuelto por Chatwoot (sent.attachments[i], alineado con files[i]):
          - upsertByChatwootAttachmentId({ messageId, chatwootAttachmentId: sent.attachments[i].id,
              fileType, contentType, filename, sizeBytes, sourceUrl: sent.attachments[i].sourceUrl,
              thumbSourceUrl: null })                            (crea la fila 'pending')
          - fileStorage.save({ key: messaging/{conversationId}/{attId}.ext, buffer: files[i].buffer, mimeType })
          - markDownloaded(attId, { storageKey })               (status → 'downloaded' — nace servible)
          ⇒ MinIO falla acá  ⇒  markFailed(attId, {error})  y NO se aborta el envío
             (el mensaje YA salió a WhatsApp; la fila queda 'failed' con sourceUrl=data_url de
              Chatwoot ⇒ el ChatMediaDownloadScheduler de Tanda 1 la re-baja sola — self-heal)
      5c. conversationRepo.upsertByChatwootId({ ..., lastMessageAt, lastMessagePreview })
   6. return toChatMessageDto(message, attachmentRecords)   // ← el mapper YA soporta el 2º arg
   ```

   **Reusa `upsertByChatwootAttachmentId` + `markDownloaded` de Tanda 1 sin agregar
   métodos al repo** (la fila pasa `pending`→`downloaded` dentro del mismo flujo). El
   `ChatMessageDto` outbound sale **con `attachments`** poblado (ver DTO abajo).

3. **Endpoint — `POST /api/messaging/conversations/:id/messages` extendido a multipart**
   (`messaging.routes.ts`). Se agrega el middleware `multer({ storage: memoryStorage,
   limits: { fileSize: 100MB, files: MAX_FILES } }).array('attachments', MAX_FILES)` **solo
   en esta ruta**, con el wrapper que traduce `LIMIT_FILE_SIZE`→413 / `LIMIT_FILE_COUNT`→400
   (clon del `uploadPhotos` de `taskAttachments.routes.ts`). RBAC intacto: `perms.send`
   (`messaging:send`).
   - **Passthrough de texto**: multer solo procesa `multipart/form-data`; un POST
     `application/json` (el camino de texto actual) **cae de largo** y lo parsea el
     `express.json` ya montado → `req.body.content`. Cero ruptura del contrato de texto.
   - **Validación de contenido revisada**: hoy exige `content` no-vacío (400). Nueva regla:
     **al menos uno de {`content` no-vacío, `files.length>0`}** — un mensaje solo-media
     (caption vacío) es válido; texto-solo sigue igual.
   - Handler: `content = req.body.content ?? ''`, `files = (req.files ?? []).map(f => ({
     buffer, filename: f.originalname, contentType: f.mimetype }))` →
     `sendMessage.execute(id, content, files)` → `201` DTO. Errores tipados nuevos
     (413/415) mapeados igual que el resto (statusMap del `errorHandler`).

4. **DTO — sin cambios de forma, se confirma el mapper**. `ChatMessageDto.attachments` y
   `toChatMessageAttachmentDto` YA existen (Tanda 1). `SendMessage` ahora **pasa los
   records de attachment** al mapper (`toChatMessageDto(message, records)`) — antes pasaba
   el default `[]`. El DTO outbound expone `url`/`thumbUrl` BE-proxy (nunca la URL de
   Chatwoot), idéntico al inbound. **Confirmado: el mapper los incluye para el outbound sin
   tocar nada.**

5. **Errores tipados** (`domain/errors/chatAttachment.ts`, YA existe): se reusan
   `AttachmentTooLargeError` (413) y se agrega, si no está, `UnsupportedAttachmentTypeError`
   (415) para el envío (Tanda 1 no lo necesitaba en el path entrante). Registrar en el
   statusMap del `errorHandler` (si falta el 415).

6. **Wiring** (`app.ts`): a `new SendMessage(...)` se le pasan además `chatAttachmentRepo`
   (ya instanciado, línea ~2501) y `taskPhotoStorage` (ya instanciado, la MISMA instancia
   MinIO). Cero infra nueva.

### Frontend (solo se describe — el detalle es `sdd-design`)

`Composer.tsx` gana:
- **Botón de adjuntar** (file picker, `accept` acotado a los tipos WhatsApp) → selección
  múltiple.
- **Preview de adjuntos seleccionados**: thumbnails (imágenes vía `URL.createObjectURL`) /
  ícono por tipo (video/audio/file, reusa `mediaIcons`) + `filename` + tamaño legible
  (`formatFileSize`, ya existe) + botón "quitar" por adjunto.
- **Envío** `multipart/form-data`: `content` + `attachments[]` (los `File`), a la MISMA
  ruta POST.
- **Optimistic UI**: se pinta la burbuja outbound con la media (desde el object URL local)
  en estado "enviando…" mientras sube; al `201` se reemplaza por el DTO del server (que
  trae `url`/`thumbUrl` BE-proxy y `status:'downloaded'`). Reusa **`MediaAttachment`** de
  Tanda 1 para el render.
- **Progreso**: barra/indicador por `onUploadProgress` de axios (subida a BE).
- **Errores**: 413/415 → mensaje claro por adjunto; 503 → "no se pudo enviar, reintentá"
  (la media local queda para reintentar, no se pierde).

---

## Qué se reusa de la Tanda 1 (sin modificar)

| Pieza | Cómo la usa Tanda 2 |
|---|---|
| `ChatMessageAttachment` (modelo + migración) | La fila outbound nace `downloaded` (storageKey seteado). **Sin cambio de schema.** |
| `ChatMessageAttachmentRepository.upsertByChatwootAttachmentId` | Crea la fila outbound (`pending`); su regla "no revierte `downloaded`" hace **inofensivo** el webhook outgoing (convergencia idempotente). |
| `…markDownloaded` / `…markFailed` | `markDownloaded` tras subir a MinIO; `markFailed` si MinIO falla (→ self-heal por scheduler). |
| `FileStorage`/`MinioFileStorage` (`taskPhotoStorage`) | `save({ key: messaging/{conv}/{id}.ext, buffer, mimeType })` con el binario del multipart. |
| `ChatMediaDownloadScheduler` (Tanda 1) | **Red de seguridad del envío**: si MinIO falló, la fila `failed` con `sourceUrl=data_url` se re-baja de Chatwoot sola. Cero código nuevo. |
| `GET /api/messaging/attachments/:id/file` | Sirve la media outbound igual que la inbound (BE-proxy). |
| `ChatMessageAttachmentDto` + `toChatMessageAttachmentDto` + `ChatMessageDto.attachments` | El DTO outbound sale idéntico al inbound. |
| `HttpChatwootGateway.toMessageDto` (con `attachments`) | Parsea la respuesta del POST multipart → obtiene `chatwootAttachmentId` + `data_url`. |
| `MAX_BYTES_BY_FILE_TYPE` (5/16/100MB) | Revalidación por tipo en el envío. |
| `contentDisposition` + `uploadPhotos` (multer wrapper) de `taskAttachments.routes.ts` | Molde del multer + límites del POST. |
| FE `MediaAttachment`/`mediaIcons`/`formatFileSize`/`ImageLightbox` | Preview + render optimista. |

---

## Contrato del endpoint (multipart)

```
POST /api/messaging/conversations/:id/messages
Auth: session + RBAC messaging:send
Content-Type: multipart/form-data   (o application/json para texto-solo — retrocompat)
  content       : string   (opcional si hay attachments; caption/texto)
  attachments[] : file*    (0..MAX_FILES; techo multer 100MB c/u; revalidado por fileType)

Respuestas:
  201  ChatMessageDto  { id, direction:'outbound', content, sentAt, attachments: [ ... ] }
  400  ni content ni attachments  |  demasiados archivos (LIMIT_FILE_COUNT)
  413  AttachmentTooLargeError    (un archivo excede el límite de SU fileType)
  415  UnsupportedAttachmentTypeError
  422  MessagingWindowExpiredError (ventana 24h cerrada — sin llamar a Chatwoot)
  404  ConversationNotFoundError
  503  ChatwootUnavailableError    (Chatwoot rechazó/timeout — NADA se persistió)
```

---

## Decisiones + justificación

### Decisión 1 — Guardado DIRECTO en MinIO al enviar (NO esperar el webhook outgoing) — **recomendado**
El BE **ya tiene el binario en memoria** (multer). Re-descargarlo del webhook saliente es
trabajo duplicado y latencia. Guardarlo directo hace que el mensaje outbound nazca
`downloaded` y **servible al instante** (optimistic UI real). Y — clave — **degrada hacia
Tanda 1 sin código nuevo**: como del POST a Chatwoot capturamos `sourceUrl = data_url`, si
MinIO falla, la fila queda `failed` con una `sourceUrl` válida y el `ChatMediaDownloadScheduler`
la re-baja de Chatwoot sola. El webhook outgoing que Chatwoot dispara después
(`message_created`, `message_type:'outgoing'` → `ReceiveChatwootWebhook` persiste outbound)
**no molesta**: re-upsertea el MISMO `chatwootMessageId` (sin duplicar) y el MISMO
`chatwootAttachmentId`, y la regla de Tanda 1 "el upsert NO revierte una fila `downloaded`"
protege el `storageKey` que ya escribimos. **Convergencia idempotente por diseño.**
*Alternativa descartada*: esperar el webhook = agente ve "enviando…" hasta el round-trip +
descarga extra + depende de que el webhook outgoing llegue. Estrictamente peor en el caso
feliz e idéntico en el de falla.

### Decisión 2 — Múltiples archivos por mensaje — **recomendado (con tope)**
El modelo es 1:N y Chatwoot acepta `attachments[]` en UN POST. Se manda **un solo POST
multipart** con todos los archivos (sin concurrencia hacia Chatwoot). Tope `MAX_FILES`
(propongo bajo, p.ej. 5–10; task-photos usa 15). *Nota*: WhatsApp puede desdoblar la
entrega en varios mensajes del lado del cliente — es problema de Chatwoot/WhatsApp, no del
BE; nosotros espejamos lo que Chatwoot devuelve.

### Decisión 3 — Optimistic UI — **recomendado**
Pintar la burbuja con la media local (object URL) en estado "enviando…" y reemplazar por el
DTO al `201`. Reusa `MediaAttachment`. Si el POST falla (413/415/503), la media local queda
para reintentar (no se pierde). *Alternativa*: esperar la confirmación (más simple, peor
percepción de latencia con archivos grandes).

### Decisión 4 — `content` + media juntos (caption) — **recomendado**
Un mensaje = `content` (caption, opcional) + `attachments[]`. WhatsApp soporta caption sobre
media; Chatwoot lo acepta en el mismo multipart. Texto-solo y media-sola son ambos válidos.
Regla: exigir **al menos uno** de los dos.

### Decisión 5 — Límite total + concurrencia — **recomendado**
Techo multer **100MB por archivo** (flat, como pide multer) + revalidación por `fileType`
(5/16/100MB) en el use-case (multer no puede variar el techo por tipo). `MAX_FILES` acotado
+ (opcional) tope de bytes TOTAL del request. Subida a Chatwoot = **1 POST** (sin
concurrencia). Guardados a MinIO: secuencial o `Promise.allSettled` (N chico).

### Decisión 6 — `FormData` con el paquete `form-data` — **recomendado**
`form-data` **no** es dep directa hoy pero **sí transitiva de axios**. Para multipart con
buffers + `filename`/`contentType` por parte, `form-data` (`form.append(name, buffer,
{filename, contentType})` + `form.getHeaders()`) es el estándar Node+axios y evita el
Blob/File global que hace incómodo setear el nombre/tipo. Se agrega como **dep explícita**
(ya está en `node_modules`).

### Decisión 7 — Thumbnail de la imagen outbound = null (fallback al original) — **recomendado**
La imagen enviada está capada a 5MB; el FE cae al original (`thumbUrl:null`, mismo fallback
del DTO). No se corre `ImageProcessor` en el envío (scope creep). *Alternativa*: generar el
thumb local con el `ImageProcessor` existente — queda para después si molesta el peso.

---

## Riesgos

- **Multipart 100MB en memoria (× N archivos)** — multer `memoryStorage` bufferea todo; un
  request con varios archivos grandes = presión de RAM (peor que Tanda 1, que baja de a uno
  serializado). *Mitigación*: `MAX_FILES` bajo + tope total + los límites WhatsApp por tipo
  (5/16/100MB) recortan antes.
- **Timeout de subida a Chatwoot / 504 en el ingress** — a diferencia del webhook entrante,
  el POST de envío es **síncrono** (el agente espera la confirmación), así que un archivo de
  100MB puede tardar y chocar un timeout de proxy/gateway (la clase de 504 que este backend
  ya sweepeó dos veces — `77a6fc97`). *Mitigación*: `timeout`/`maxBodyLength` explícitos en
  el POST multipart del gateway, `MAX_FILES` y tope total conservadores. **No** se puede
  volver async trivialmente (el agente necesita el resultado del envío). Documentado como
  gate de rollout, no como bug.
- **Chatwoot OK pero MinIO falla** — **auto-resuelto** (Decisión 1): fila `failed` con
  `sourceUrl=data_url` → el `ChatMediaDownloadScheduler` de Tanda 1 la re-baja. Sin
  compensación nueva. (El caso inverso — MinIO OK pero Chatwoot falla — no existe: Chatwoot
  se llama PRIMERO; si falla, no se escribe nada.)
- **La respuesta del POST no trae `attachments[]` con `id`/`data_url`** — rompería el
  `chatwootAttachmentId` (`@@unique`) y el self-heal. *Verificar en vivo contra `.37`* que el
  POST multipart devuelve el mensaje con sus attachments poblados (Decisión abierta D). Si
  faltara, fallback: `sourceUrl=''` (como el inbound) — pero el self-heal no aplicaría.
- **`MINIO_*` no seteadas en prod** (opt-in, no fail-fast — igual que Tanda 1): el envío a
  Chatwoot igual funciona (el mensaje sale a WhatsApp), pero el espejo local queda `failed`.
  Degrada limpio; prerequisito de rollout = `MINIO_*` seteadas.

---

## Fuera de scope (fases futuras)

- **Audio grabado in-app** (grabación por micrófono en el composer) — requiere captura de
  media del browser + encoding; decisión aparte.
- **Stickers / emojis-media / GIFs animados** de WhatsApp — tipos especiales, no en fase A.
- **Edición / borrado** de un mensaje/media ya enviado desde Prominense.
- **Thumbnails de video/audio** en el envío (poster-frame) — requiere ffmpeg, igual que en
  Tanda 1.
- **Reintento manual del envío desde el FE más allá del optimistic** — el self-heal del
  scheduler cubre el espejo; el re-envío a Chatwoot lo decide el agente re-mandando.

---

## Decisiones abiertas — necesitan OK del arquitecto antes del spec

- **A. Guardado directo en MinIO al enviar** (Decisión 1) — ¿confirmás directo + self-heal
  por el scheduler de Tanda 1, en vez de esperar el webhook outgoing? *(Recomiendo directo.)*
- **B. Múltiples archivos por mensaje** (Decisión 2) — ¿un mensaje con `attachments[]`
  múltiples (recomendado) y qué `MAX_FILES` (propongo 5–10)? ¿o uno por vez?
- **C. Optimistic UI** (Decisión 3) — ¿mostrar la media local mientras sube (recomendado) o
  esperar el `201`?
- **D. Verificación del POST multipart en vivo** — confirmar contra `.37` que la respuesta
  del `POST …/messages` (multipart) devuelve el mensaje con `attachments[]` poblados
  (`id`, `data_url`) → es lo que sostiene `chatwootAttachmentId`, `sourceUrl` y el self-heal.
- **E. Límite total + `MAX_FILES` + timeout del multipart** (Decisión 5) — ¿valores? (100MB
  flat/archivo + revalidación por tipo + `MAX_FILES` bajo + `timeout` explícito del POST a
  Chatwoot; ¿tope total del request?)
- **F. `content` + media juntos** (Decisión 4) — ¿caption permitido (recomendado, "al menos
  uno de content/files") o media-sola?
- **G. Extender `SendMessage` vs use case nuevo** — recomiendo **extender** `SendMessage`
  (mismo orden de guardas 404→422→…→503, un solo lugar) con `files?` opcional; alternativa:
  `SendMessageWithAttachments` separado (más archivos, más duplicación del guard-order).
- **H. Thumbnail outbound** (Decisión 7) — ¿`thumbUrl:null` con fallback al original
  (recomendado) o generar thumb local con `ImageProcessor`?
