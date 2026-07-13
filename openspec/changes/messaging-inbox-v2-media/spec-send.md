# Spec (delta) — messaging-inbox-v2-media · F1.5 fase A · **TANDA 2: ENVIAR MEDIA**

RFC-2119. Mismo estilo que `spec.md` (Tanda 1) y `openspec/specs/messaging-inbox/spec.md`
(F1, capability "envío dentro de ventana 24h"). Cada scenario cubierto por al menos un
test verde (sdd-verify), in-memory ports/fakes, sin mockear Prisma ni axios real.

> Alcance: SOLO enviar media desde el composer. Extiende `SendMessage` (NO use case
> nuevo — decisión confirmada) reusando el modelo, repo, storage y scheduler de Tanda 1
> sin tocarlos.

## Nota de reconciliación de numeración (no es un requirement)

`SEND-1` en este archivo **REEMPLAZA** (`MODIFIED`) al `SEND-1` de
`openspec/specs/messaging-inbox/spec.md` — mismo identificador, mismo requirement, texto
extendido. `SEND-2` (422 ventana expirada) y `SEND-3` (503 Chatwoot caído) de ese spec
**NO se tocan**: su comportamiento no cambia con adjuntos, sus scenarios siguen vigentes
tal cual; esta tanda solo agrega, DENTRO de `SEND-1`, los scenarios de interacción entre
esas guardas y `files`. Los requirements genuinamente nuevos continúan la numeración en
`SEND-4..SEND-8` — a propósito NO se reutilizan `SEND-2`/`SEND-3` para otra cosa, para no
colisionar con el identificador ya citado en comentarios de código (`SendMessage.ts`,
`messaging.routes.ts`).

## MODIFIED Requirements

### Requirement: SEND-1 — envío exitoso dentro de la ventana (extendido a texto y/o adjuntos, orden de guardas pinneado)

`SendMessage.execute(conversationId, content, files?)` MUST aceptar `files?:
OutboundAttachmentFile[]` (`{ buffer, filename, contentType }`) como 3er argumento
opcional (aditivo, retrocompatible: sin `files` el comportamiento es idéntico al F1
actual). El sistema MUST ejecutar las guardas en este orden exacto, cortando en la
primera que falle:

1. `conversationRepo.findById(id)` → si no existe, 404 `ConversationNotFoundError`.
2. `!conversation.canReply` → 422 `MessagingWindowExpiredError`, **sin llamar a
   Chatwoot ni validar `files`** (SEND-2 no cambia; esta guarda sigue yendo ANTES que
   la validación de adjuntos).
3. Validar TODO el lote de `files` **upfront**: derivar `fileType` del `contentType`
   (`image/* → 'image'`, `video/* → 'video'`, `audio/* → 'audio'`, resto → `'file'`) y
   revalidar `sizeBytes` contra `MAX_BYTES_BY_FILE_TYPE` (5/16/16/100MB, reusa la tabla
   de `DownloadChatMessageAttachment.ts`). Si CUALQUIER archivo del lote falla, MUST NOT
   enviarse ninguno (mismo criterio "todo o nada" que `AttachPhotosToTask`).
4. `gateway.sendMessage(chatwootConversationId, content, files)` → cualquier falla
   (SEND-3, sin cambios) → 503 `ChatwootUnavailableError`, **con `files`: tampoco se
   persiste nada** (ni `ChatMessage` ni `ChatMessageAttachment`).

(Previously: solo aceptaba `content: string`; sin adjuntos, sin guardas 415/413.)

#### Scenario: conversación inexistente — 404 (gap documentado, ya en código sin spec)
- GIVEN un `conversationId` que no existe en el mirror
- WHEN se invoca `execute` (con o sin `files`)
- THEN lanza `ConversationNotFoundError`, sin tocar Chatwoot ni el repo de mensajes

#### Scenario: ventana cerrada — 422 antes de validar `files`
- GIVEN `canReply=false` y un lote de `files` con un archivo demasiado grande
- WHEN se invoca `execute`
- THEN lanza `MessagingWindowExpiredError` SIN evaluar el tamaño/tipo de ningún
  archivo y SIN llamar a Chatwoot (la guarda 2 corta antes que la 3)

#### Scenario: tipo no soportado — 415, lote completo rechazado
- GIVEN un lote de 3 archivos donde uno tiene `contentType` vacío/no clasificable
- WHEN se invoca `execute`
- THEN lanza `UnsupportedAttachmentTypeError` y NINGÚN archivo se manda a Chatwoot

#### Scenario: tamaño excedido por `fileType` — 413, lote completo rechazado
- GIVEN un archivo `image` de 6MB (excede el techo de 5MB de su `fileType`)
- WHEN se invoca `execute`
- THEN lanza `AttachmentTooLargeError` antes de llamar al gateway, ningún archivo se
  sube ni se persiste

#### Scenario: Chatwoot caído con adjuntos — 503, nada persistido
- GIVEN la ventana abierta y un lote de `files` válido, pero el POST a Chatwoot
  falla (red/timeout/5xx)
- WHEN se invoca `execute`
- THEN lanza `ChatwootUnavailableError`; NO se crea el `ChatMessage` NI ninguna fila
  `ChatMessageAttachment`, y `FileStorage.save` NUNCA se invoca

#### Scenario: caption + adjuntos, y adjuntos sin caption
- GIVEN `content='mirá el plan'` + 1 imagen, Y por separado `content=''` + 1 imagen
- WHEN se invoca `execute` en ambos casos con la ventana abierta
- THEN ambos casos pasan las guardas (ninguno de los dos se rechaza por el otro
  campo vacío) y llegan al gateway

## ADDED Requirements

### Requirement: SEND-4 — gateway multipart (`HttpChatwootGateway.sendMessage` extendido)

`ChatwootGateway.sendMessage(chatwootConversationId, content, files?)` MUST, cuando
`files` tiene al menos un elemento, armar un `FormData` (paquete `form-data`, agregado
como dependencia explícita) con `content`, `message_type: 'outgoing'` y un
`form.append('attachments[]', buffer, { filename, contentType })` por archivo, y hacer
`POST` con `headers: form.getHeaders()` más `timeout`/`maxBodyLength`/`maxContentLength`
explícitos (mismo criterio de `rawGet` en `downloadAttachment`, MEDIA-2). Sin `files`,
MUST conservar el POST JSON actual (cero regresión). La respuesta MUST mapearse con el
mismo `toMessageDto` (ya soporta `attachments[]`, MEDIA-1).

#### Scenario: con adjuntos — multipart con timeout explícito
- GIVEN `files` con 2 elementos
- WHEN se llama `sendMessage(id, content, files)`
- THEN el POST sale como `multipart/form-data` con 2 partes `attachments[]` +
  `content` + `message_type`, y con `timeout`/`maxBodyLength` seteados (no infinito)

#### Scenario: sin adjuntos — el camino JSON no cambia
- GIVEN `files` es `undefined` o `[]`
- WHEN se llama `sendMessage(id, content)`
- THEN el POST sale igual que en F1 (`{ content, message_type: 'outgoing' }`, sin
  `FormData`), verificando cero regresión

#### Scenario: la respuesta trae `attachments[]` con `id` y `data_url`
- GIVEN un POST multipart aceptado por Chatwoot
- WHEN se mapea la respuesta
- THEN el `ChatwootMessageDto` resultante incluye `attachments[]` con
  `id`/`sourceUrl` poblados por cada archivo enviado (verificado en vivo,
  `_message.json.jbuilder:14`)

#### Scenario: timeout/red caída en el POST multipart — outcome único
- GIVEN el POST multipart no responde dentro del `timeout` configurado
- WHEN se llama `sendMessage`
- THEN lanza `ChatwootUnavailableError` (mismo outcome único que cualquier falla de
  axios, SEND-3), nunca deja la promesa pendiente

### Requirement: SEND-5 — espejo post-OK: MinIO directo, convergencia idempotente, self-heal

Tras un `gateway.sendMessage` exitoso, por cada `sent.attachments[i]` (alineado
posicionalmente con `files[i]`, ya validado en SEND-1), el sistema MUST:
`upsertByChatwootAttachmentId({ messageId, chatwootAttachmentId: sent.attachments[i].id,
fileType, contentType, filename, sizeBytes, sourceUrl: sent.attachments[i].sourceUrl,
thumbSourceUrl: null })` (usa `fileType`/`contentType`/`filename`/`sizeBytes` de
**nuestro** `files[i]`, ya validado), luego `fileStorage.save({ key:
messaging/{conversationId}/{id}.ext, buffer: files[i].buffer, mimeType })`, luego
`markDownloaded(attId, { storageKey })`. Si `FileStorage.save` o `markDownloaded` fallan
para un archivo, el sistema MUST `markFailed(attId, { error })` y MUST NOT abortar el
envío ni los demás archivos del lote — el mensaje YA salió a WhatsApp.

#### Scenario: happy path — Chatwoot OK + MinIO OK
- GIVEN un envío con 2 adjuntos válidos
- WHEN `sendMessage` responde OK y ambos `fileStorage.save` tienen éxito
- THEN existen 2 filas `ChatMessageAttachment` en `status='downloaded'` con
  `storageKey` seteado, y el DTO de respuesta las incluye

#### Scenario: Chatwoot OK + MinIO falla — self-heal, el mensaje igual salió
- GIVEN un envío con 1 adjunto, `sendMessage` responde OK pero `fileStorage.save`
  lanza (MinIO caído)
- WHEN se ejecuta el use case
- THEN la fila queda `status='failed'` con `sourceUrl` = el `data_url` de Chatwoot y
  `lastError` seteado, PERO el `ChatMessage` se upsertea igual y `execute` retorna
  201 (el envío NO falla por esto) — el `ChatMediaDownloadScheduler` de Tanda 1
  re-baja esa fila sola en su próximo barrido, sin código nuevo

#### Scenario: múltiples archivos — alineación por índice
- GIVEN un lote de 3 `files` distintos (imagen, PDF, audio)
- WHEN `sent.attachments` vuelve con 3 entradas
- THEN cada `ChatMessageAttachmentRecord` usa el `sourceUrl`/`chatwootAttachmentId`
  de la entrada EN LA MISMA POSICIÓN que su archivo origen (ver nota de riesgo en
  Decisiones abiertas sobre el supuesto de orden preservado)

#### Scenario: webhook outgoing posterior — inofensivo (convergencia idempotente)
- GIVEN una fila ya `downloaded` (creada por este flujo síncrono)
- WHEN llega después el webhook `message_created` (`message_type: 'outgoing'`) para
  el MISMO `chatwootMessageId`/`chatwootAttachmentId`
- THEN el upsert del webhook NO revierte `status` a `pending` ni borra `storageKey`
  (regla ya garantizada por Tanda 1, MEDIA-1 scenario 2 — sin cambios)

### Requirement: SEND-6 — endpoint multipart (`POST /conversations/:id/messages` extendido)

El endpoint MUST montar `multer({ storage: memoryStorage, limits: { fileSize: 100MB,
files: MAX_FILES=10 } }).array('attachments', 10)` **solo en esta ruta**, con un wrapper
que traduce `LIMIT_FILE_SIZE`→413 y `LIMIT_FILE_COUNT`/`LIMIT_UNEXPECTED_FILE`→400 (clon
de `uploadPhotos` en `taskAttachments.routes.ts`). Un POST `application/json` (texto
solo) MUST seguir cayendo por `express.json` sin pasar por multer. La validación de
contenido MUST exigir al menos uno de `{content no-vacío, files.length>0}` → 400 si
ninguno. RBAC MUST seguir siendo `messaging:send` (RBAC-2, sin cambios).

#### Scenario: multipart con caption + adjuntos — 201
- GIVEN un POST `multipart/form-data` con `content='mirá esto'` y 2 `attachments[]`
- WHEN se procesa
- THEN responde 201 con el DTO, `content` y `attachments` poblados

#### Scenario: multipart solo adjuntos, sin caption — 201
- GIVEN un POST con `attachments[]` pero sin campo `content`
- WHEN se procesa
- THEN `content` se toma como `''` y responde 201 (no se rechaza por caption vacío)

#### Scenario: ni content ni attachments — 400
- GIVEN un POST `multipart/form-data` sin `content` y sin ningún archivo
- WHEN se procesa
- THEN responde 400 `{ code: 'VALIDATION_ERROR' }` sin invocar `sendMessage.execute`

#### Scenario: más de MAX_FILES=10 — 400
- GIVEN un POST con 11 archivos bajo `attachments[]`
- WHEN multer lo procesa
- THEN responde 400 `{ code: 'TOO_MANY_FILES' }` (traducido de `LIMIT_FILE_COUNT`),
  sin llegar al use case

#### Scenario: archivo > 100MB — 413 a nivel multer
- GIVEN un archivo de 120MB en `attachments[]`
- WHEN multer lo procesa
- THEN responde 413 `{ code: 'FILE_TOO_LARGE' }` ANTES de que el handler o el use
  case se ejecuten (el techo flat de multer corta primero; el 413 por `fileType`
  de SEND-1 cubre los casos que pasan el flat pero exceden su límite específico,
  p.ej. una imagen de 6MB)

#### Scenario: texto-solo JSON — passthrough sin regresión
- GIVEN un POST `application/json` con `{ content: 'hola' }` (sin adjuntos)
- WHEN se procesa
- THEN se comporta idéntico a F1 (multer no interviene, `express.json` parsea
  `req.body.content`), responde 201

### Requirement: SEND-7 — el DTO outbound expone `attachments` (mapper ya soportado)

`SendMessage` MUST pasar los `ChatMessageAttachmentRecord` recién creados a
`toChatMessageDto(message, records)` (en vez del default `[]` de F1). El DTO resultante
MUST cumplir la MISMA regla de no-leak que MEDIA-4 (nunca `sourceUrl`/`storageKey`/etc.),
sin tocar el mapper existente.

#### Scenario: outbound con adjuntos — DTO poblado, sin leak
- GIVEN un envío con 1 imagen ya `downloaded`
- WHEN se mapea la respuesta
- THEN `ChatMessageDto.attachments[0]` trae `{id, fileType, url, thumbUrl,
  status:'downloaded', ...}` y NO contiene `sourceUrl` ni `storageKey`

#### Scenario: outbound solo texto — attachments vacío (sin regresión)
- GIVEN un envío sin `files`
- WHEN se mapea la respuesta
- THEN `attachments: []`, igual que el comportamiento F1 actual

### Requirement: SEND-8 — robustez (lección 504 + el storage nunca acopla el envío)

Todo handler async de esta ruta MUST resolver con `next(err)` ante cualquier error no
tipado. El `timeout`/`maxBodyLength` explícitos del gateway (SEND-4) MUST convertir un
POST colgado en un 503 controlado ANTES de que un proxy/ingress externo lo corte con un
504 (la clase de bug ya sweepeada en este repo, `77a6fc97`). Una falla de
`FileStorage`/MinIO (SEND-5) MUST NOT cambiar el status code ni el body de la respuesta
del envío — el envío a Chatwoot es la única fuente de verdad del éxito HTTP.

#### Scenario: timeout controlado evita el 504 de proxy
- GIVEN un archivo grande cuyo POST a Chatwoot tardaría más que cualquier timeout
  de ingress
- WHEN se envía
- THEN el gateway corta con `ChatwootUnavailableError` (503) dentro de su propio
  `timeout` configurado, nunca deja que el ingress externo sea quien corte

#### Scenario: MinIO caído no degrada el código de respuesta del envío
- GIVEN `sendMessage` exitoso pero `FileStorage.save` lanzando para todos los
  adjuntos
- WHEN se ejecuta `execute`
- THEN la respuesta sigue siendo 201 con el `ChatMessage` creado (attachments en
  `status='failed'` pero presentes en el DTO), nunca 500/503 por esto

#### Scenario: error no tipado en el handler — no cuelga
- GIVEN `sendMessage.execute` lanza una excepción no controlada (bug)
- WHEN se ejecuta el handler
- THEN responde con un status de error inmediato vía `next(err)`, nunca cuelga el
  request

---

## Contrato — firmas (referencia)

```ts
interface OutboundAttachmentFile { buffer: Buffer; filename: string; contentType: string }

// domain/ports/ChatwootGateway.ts
sendMessage(chatwootConversationId: number, content: string, files?: OutboundAttachmentFile[]): Promise<ChatwootMessageDto>

// application/use-cases/messaging/SendMessage.ts
execute(conversationId: string, content: string, files?: OutboundAttachmentFile[]): Promise<ChatMessageDto>
```

Errores nuevos: `UnsupportedAttachmentTypeError` en `domain/errors/chatAttachment.ts`
(código `CHAT_ATTACHMENT_UNSUPPORTED_TYPE` → 415 en `statusMap`). **Ojo**: ya existe un
`UnsupportedAttachmentTypeError` homónimo en `domain/errors/taskAttachment.ts` (dominio
scheduling) — son DOS clases distintas en DOS módulos distintos; `sdd-apply` MUST
importar la de `chatAttachment.ts` en este flujo, nunca la de scheduling (typo de import
fácil de cometer, mismo nombre exportado).

## Contrato — endpoint

```
POST /api/messaging/conversations/:id/messages
Auth: session + RBAC messaging:send (sin cambios, RBAC-2)
Content-Type: multipart/form-data (nuevo) | application/json (F1, sin cambios)
  content       : string  (opcional si hay attachments)
  attachments[] : file*   (0..10, ≤100MB c/u vía multer; revalidado por fileType)

201  ChatMessageDto { id, direction:'outbound', content, sentAt, attachments:[...] }
400  ni content ni attachments | > 10 archivos (LIMIT_FILE_COUNT)
404  ConversationNotFoundError
413  FILE_TOO_LARGE (multer, flat 100MB) | CHAT_ATTACHMENT_TOO_LARGE (por fileType)
415  CHAT_ATTACHMENT_UNSUPPORTED_TYPE
422  MESSAGING_WINDOW_EXPIRED (sin llamar a Chatwoot)
503  CHATWOOT_UNAVAILABLE (nada persistido)
```

## Límites (referencia, reusa MEDIA-2)

| fileType | max/archivo | Notas |
|---|---|---|
| image | 5MB | multer flat = 100MB corta primero si aplica |
| video / audio | 16MB | ídem |
| file | 100MB | coincide con el flat de multer |
| — | MAX_FILES=10 | por request |
| — | timeout/maxBodyLength | explícitos en el POST del gateway (valor exacto: abierto) |

---

## Test scenarios (resumen para sdd-tasks/sdd-apply, strict TDD)

1. `canReply=false` → 422 sin llamar a Chatwoot, sin validar `files`.
2. Conversación inexistente → 404 (con o sin `files`).
3. Archivo con `contentType` no clasificable → 415, lote completo rechazado.
4. Archivo excede su límite por `fileType` → 413, lote completo rechazado.
5. Chatwoot 503 (con o sin `files`) → nada persistido (ni mensaje ni attachments).
6. Chatwoot OK + MinIO OK → attachments `downloaded`, DTO poblado.
7. Chatwoot OK + MinIO falla → mensaje sale igual (201), attachment `failed`, self-heal
   por el scheduler de Tanda 1.
8. Múltiples archivos en un solo POST — alineación por índice.
9. `content` + `files` (caption) — ambos válidos.
10. `files` sin `content` — válido (`content=''`).
11. Timeout del POST a Chatwoot → 503 controlado, no 504 de proxy.
12. Endpoint: ni `content` ni `attachments` → 400.
13. Endpoint: >10 archivos → 400 (`LIMIT_FILE_COUNT`).
14. Endpoint: archivo >100MB → 413 a nivel multer (antes del use case).
15. Endpoint: POST JSON texto-solo — passthrough sin regresión.
16. DTO outbound con adjuntos — sin leak de `sourceUrl`/`storageKey`.
17. Gateway: sin `files` — camino JSON intacto (cero regresión).
18. Webhook outgoing posterior sobre una fila ya `downloaded` — inofensivo.

---

## Decisiones abiertas

- **Tope total de bytes por request y valor exacto del `timeout`/`maxBodyLength` del
  POST multipart** — el proposal (Decisión 5/6, riesgo "Timeout de subida") deja el
  MECANISMO confirmado (multer flat 100MB + revalidación por tipo + `MAX_FILES=10` +
  timeout explícito) pero NO los valores numéricos exactos del timeout ni si existe un
  tope de bytes TOTAL del request (no solo por archivo) — pendiente para `sdd-design`
  o `sdd-tasks`.
- **Orden de `sent.attachments[]` vs `files[]`** — SEND-5 asume alineación posicional
  (confirmado por el proposal), pero no hay verificación en vivo de que Chatwoot
  preserve el ORDEN de envío cuando hay 2+ archivos en el mismo POST (solo se verificó
  que la respuesta trae `attachments[]` poblado, no su orden relativo). Riesgo bajo
  (mismo tipo de dato en ambos lados) pero no cerrado con evidencia — recomendado
  verificar en vivo contra `.37` con un envío de 2+ archivos antes de dar por sentado el
  matching posicional en `sdd-apply`.
- **Semántica exacta de 415** — con la clasificación `image/video/audio/* → su
  categoría, resto → 'file'`, la única vía documentada para disparar
  `UnsupportedAttachmentTypeError` es un `contentType` vacío/ausente (la clasificación
  es exhaustiva-con-catch-all). Si el arquitecto quiere además bloquear tipos
  específicos (ej. ejecutables) más allá de ese caso borde, es un requirement adicional
  no cubierto acá.
