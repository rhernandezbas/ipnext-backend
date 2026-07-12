# Spec (delta) — messaging-inbox-v2-media · F1.5 fase A · **TANDA 1: RECIBIR MEDIA**

RFC-2119. Mismo estilo que `openspec/specs/messaging-inbox/spec.md` (F1) y
`openspec/changes/messaging-inbox-v2/spec.md` (Grupo B). Cada scenario cubierto
por al menos un test verde (sdd-verify), in-memory ports, sin mockear Prisma.

> Alcance: SOLO recibir media entrante (webhook + fetch-on-open) y servirla
> BE-proxy. Requirements NUEVOS (`ADDED`) — no reescribe `HOOK-4` (upsert de
> `ChatMessage`) ni `INBOX-2` (fetch-on-open): esta tanda agrega una rama nueva
> dentro de esos flujos ya existentes, sin cambiar ninguno de sus scenarios ya
> verdes. Enviar media (composer) es Tanda 2, fuera de scope.

## ADDED Requirements

### Requirement: MODEL-1 — modelo `ChatMessageAttachment` (migración aditiva)

El sistema MUST definir un modelo `ChatMessageAttachment` (1:N con `ChatMessage`,
`onDelete: Cascade`) vía migración aditiva (`CREATE TABLE` + índices + FK, clon
del molde de `20260823000000_add_scheduled_task_attachment`), y MUST agregar la
relación inversa `attachments ChatMessageAttachment[]` a `ChatMessage` sin tocar
ninguna columna existente. `chatwootAttachmentId` MUST ser único (idempotencia).
MUST existir índice por `messageId` (mapper sin N+1) y por `status` (barrido del
scheduler).

#### Scenario: migración aplica limpio en entorno nuevo
- GIVEN Postgres con el schema actual de `messaging-inbox` ya aplicado
- WHEN corre la migración de `ChatMessageAttachment`
- THEN la tabla existe con FK a `ChatMessage` (cascade), `ChatMessage` gana la
  relación `attachments`, y ningún dato/columna previa de `ChatMessage` cambia

#### Scenario: `chatwootAttachmentId` duplicado — constraint
- GIVEN una fila con `chatwootAttachmentId = 42`
- WHEN se intenta insertar otra fila con el mismo `chatwootAttachmentId`
- THEN Postgres rechaza por el `@@unique`, forzando upsert en la capa de
  aplicación en vez de insert ciego

#### Scenario: FK cascade al borrar el mensaje
- GIVEN un `ChatMessage` con 2 `ChatMessageAttachment` asociados
- WHEN se borra ese `ChatMessage`
- THEN sus attachments se borran en cascada (no quedan filas huérfanas)

### Requirement: MEDIA-1 — captura sync idempotente en webhook y fetch-on-open

Para cada adjunto reportado por Chatwoot cuyo `fileType ∈ {image, audio, video,
file}`, el sistema MUST crear (upsert idempotente por `chatwootAttachmentId`,
`status='pending'`) una fila `ChatMessageAttachment` en la MISMA rama donde ya
se persiste el `ChatMessage` (`direction !== null && !isPrivate && payload.id
!== undefined`), **sin descargar el binario**. Adjuntos con `fileType ∈
{location, contact, fallback, embed}` MUST NOT generar fila (no son binarios
descargables). El mismo mapeo MUST aplicarse en el path de fetch-on-open
(`GetConversation.syncFromChatwoot` / `HttpChatwootGateway`), para paridad
entre webhook y GET.

#### Scenario: captura idempotente — dos webhooks, un solo adjunto
- GIVEN Chatwoot reenvía el mismo `message_created` dos veces (retry propio de
  Chatwoot), mismo `chatwootAttachmentId`
- WHEN ambos webhooks se procesan
- THEN existe UNA sola fila `ChatMessageAttachment` para ese id, `status`
  intacto respecto a la primera escritura

#### Scenario: reintento de webhook sobre un adjunto ya `downloaded`
- GIVEN una fila `ChatMessageAttachment` en `status='downloaded'` con
  `storageKey` seteado
- WHEN llega de nuevo el mismo `message_created` (mismo `chatwootAttachmentId`)
- THEN el upsert NO revierte `status` a `pending` ni borra `storageKey`

#### Scenario: mensaje solo-attachment — content vacío
- GIVEN un `message_created` con `content: ''` y un adjunto `image`
- WHEN se procesa
- THEN el `ChatMessage` se crea con `content=''` Y su `ChatMessageAttachment`
  en `pending` (ninguno de los dos se descarta por el content vacío)

#### Scenario: fileType no-binario se ignora
- GIVEN un `message_created` con un adjunto `fileType='location'` (o
  `contact`/`fallback`/`embed`)
- WHEN se procesa
- THEN NO se crea ninguna fila `ChatMessageAttachment` para ese adjunto, y el
  `ChatMessage` se persiste igual (sin ese adjunto)

#### Scenario: fetch-on-open también captura
- GIVEN una conversación cuyo mirror está desactualizado y el mensaje real en
  Chatwoot trae adjuntos
- WHEN `GET /api/messaging/conversations/:id` dispara el fetch-on-open
  (INBOX-2)
- THEN los adjuntos de los mensajes traídos se capturan igual que en el
  webhook (mismas filas `pending`, mismo criterio de idempotencia)

### Requirement: MEDIA-2 — descarga async, validación de tamaño, thumbnail

`DownloadChatMessageAttachment` MUST: seguir el `sourceUrl` (`data_url` de
Chatwoot — 301 estable, verificado en vivo que NO requiere el
`api_access_token`) sin reenviar headers de autenticación al destino del
redirect; validar el tamaño real por `fileType` (imagen 5MB, video/audio 16MB,
documento 100MB) tanto contra el `sizeBytes` reportado (fail-fast sin
descargar) como contra los bytes efectivamente bajados; en éxito, `FileStorage
.save({ key: messaging/{conversationId}/{attachmentId}.ext })` y, si
`fileType==='image'` y hay `thumbSourceUrl`, bajar también el thumb a
`thumbStorageKey`; luego `markDownloaded`. MUST ser idempotente: si la fila ya
está `downloaded`, MUST NOT volver a descargar. Cualquier falla (red, tamaño,
tipo, storage no configurado) MUST terminar en `markFailed`
(`downloadAttempts+1`, `lastError`), nunca dejar la fila en un estado
intermedio.

#### Scenario: happy path — imagen con thumbnail
- GIVEN una fila `pending` con `fileType='image'`, `sourceUrl` y
  `thumbSourceUrl` válidos, dentro del límite de 5MB
- WHEN se ejecuta el use case
- THEN el binario y el thumbnail quedan en MinIO, la fila pasa a `downloaded`
  con `storageKey` y `thumbStorageKey` seteados

#### Scenario: tamaño excedido — falla sin subir nada
- GIVEN una fila `pending` con `fileType='file'` cuyo tamaño real (reportado o
  descargado) supera 100MB
- WHEN se ejecuta el use case
- THEN NO se llama a `FileStorage.save`, la fila pasa a `failed` con
  `downloadAttempts+1` y `lastError` describiendo el exceso

#### Scenario: follow-redirect del `data_url`
- GIVEN un `sourceUrl` que responde 301 hacia la blob real
- WHEN se descarga
- THEN el cliente sigue el redirect automáticamente y NO reenvía ningún header
  sensible (auth/token) al host de destino del redirect

#### Scenario: red caída / Chatwoot no responde
- GIVEN Chatwoot inalcanzable o el request al `sourceUrl` timeoutea
- WHEN se ejecuta el use case
- THEN `markFailed` incrementa `downloadAttempts` en 1 y guarda `lastError`
  con el motivo, sin lanzar una excepción no controlada

#### Scenario: ya `downloaded` — no se re-descarga
- GIVEN una fila ya `status='downloaded'`
- WHEN se invoca el use case de nuevo para ese `attachmentId` (disparo
  duplicado del trigger o del scheduler)
- THEN el use case retorna sin volver a pegarle a `sourceUrl` ni a
  `FileStorage`

### Requirement: MEDIA-3 — scheduler de reintento (clon `RadiusAuthIngestScheduler`)

`ChatMediaDownloadScheduler` MUST correr cada ~2 minutos, gateado por el
feature flag `chat-media-download` (dark por defecto), tomar
`DistributedLock('chat-media-download')` y respetar el flag `inFlight` (una
corrida a la vez). MUST barrer `listRetriable({ status IN ('pending',
'failed'), downloadAttempts < 5 })` e invocar `DownloadChatMessageAttachment`
por cada fila. Una descarga individual que falla MUST NOT detener el resto del
barrido ni tumbar el loop del scheduler.

#### Scenario: recupera un `pending` que nunca se disparó
- GIVEN una fila `pending` (el proceso se reinició antes de que el
  fire-and-forget terminara)
- WHEN corre el barrido del scheduler
- THEN la fila se reintenta y, si Chatwoot responde, termina `downloaded`

#### Scenario: reintenta un `failed` con intentos disponibles
- GIVEN una fila `failed` con `downloadAttempts=2`
- WHEN corre el barrido
- THEN se reintenta la descarga (no queda excluida por el filtro)

#### Scenario: `downloadAttempts >= 5` — se abandona
- GIVEN una fila `failed` con `downloadAttempts=5`
- WHEN corre el barrido
- THEN esa fila NO se incluye en `listRetriable` (queda `failed` en pausa,
  sin bucle infinito de reintento)

#### Scenario: feature flag apagado — el scheduler no barre
- GIVEN el flag `chat-media-download` deshabilitado
- WHEN llega el tick del `setInterval`
- THEN no se ejecuta ningún barrido (dark by default, prerequisito de
  rollout documentado en el proposal)

#### Scenario: una descarga falla — el resto del barrido continúa
- GIVEN un barrido con 3 filas retriables, una de ellas lanza una excepción
  no controlada
- WHEN corre el scheduler
- THEN las otras 2 filas se procesan igual y el scheduler sigue vivo para el
  próximo tick

### Requirement: MEDIA-4 — DTO de adjunto sin leak de campos internos

`ChatMessageDto` MUST ganar `attachments: ChatMessageAttachmentDto[]`. El DTO
MUST exponer únicamente `{id, fileType, contentType, filename, fileSize,
width, height, status, url, thumbUrl}`. MUST NOT exponer `sourceUrl`,
`thumbSourceUrl`, `storageKey`, `thumbStorageKey`, `lastError` ni
`downloadAttempts` bajo ningún campo. `url`/`thumbUrl` MUST ser rutas
BE-proxy (`/api/messaging/attachments/:id/file[?variant=thumb]`), nunca una
URL de Chatwoot.

#### Scenario: no leak de campos internos
- GIVEN un `ChatMessageAttachment` con `sourceUrl`, `storageKey` y
  `lastError` seteados
- WHEN se mapea a `ChatMessageAttachmentDto`
- THEN el JSON de respuesta NO contiene ninguna de esas claves (ni anidadas)

#### Scenario: `status` expuesto tal cual para el placeholder del FE
- GIVEN un adjunto en `pending` o `failed`
- WHEN se mapea a DTO
- THEN `status` viaja sin transformar (`'pending'`/`'failed'`), permitiendo
  al FE pintar el placeholder/error sin pegarle al endpoint de servido

#### Scenario: `thumbUrl` null para tipos sin thumbnail
- GIVEN un adjunto `fileType='video'` (o `audio`/`file`, sin
  `thumbStorageKey`)
- WHEN se mapea a DTO
- THEN `thumbUrl` es `null`

### Requirement: MEDIA-5 — endpoint de servido BE-proxy

`GET /api/messaging/attachments/:id/file?variant=original|thumb` MUST estar
gateado por `messaging:read` (mismo guard de INBOX-1/2/3) y MUST resolver el
attachment por `id` vía su propio repositorio (nunca aceptar una `storageKey`
o URL cruda como input). `variant=thumb` sin `thumbStorageKey` MUST caer al
original. MUST responder con `Content-Type` = `contentType` y
`Content-Disposition` RFC 5987 seguro (clon del helper de
`taskAttachments.routes.ts`).

#### Scenario: sirve el original
- GIVEN un attachment `status='downloaded'` con `storageKey` válido
- WHEN se pide `?variant=original` (o sin `variant`)
- THEN responde 200 con el binario desde MinIO, `Content-Type` correcto

#### Scenario: sirve el thumb, con fallback
- GIVEN un attachment `image` `downloaded` con `thumbStorageKey`
- WHEN se pide `?variant=thumb`
- THEN responde 200 con el thumbnail
- GIVEN el mismo attachment SIN `thumbStorageKey` (p.ej. `video`)
- WHEN se pide `?variant=thumb`
- THEN responde 200 con el ORIGINAL (fallback, mismo criterio que
  `ScheduledTaskAttachmentDto`)

#### Scenario: no listo — 409
- GIVEN un attachment `status IN ('pending','failed')`
- WHEN se pide el endpoint (cualquier variant)
- THEN responde 409 `AttachmentNotReadyError`, sin tocar MinIO

#### Scenario: inexistente — 404
- GIVEN un `:id` que no corresponde a ningún `ChatMessageAttachment`
- WHEN se pide el endpoint
- THEN responde 404 `AttachmentNotFoundError`

#### Scenario: sin permiso — 403
- GIVEN un usuario autenticado sin `messaging:read`
- WHEN pide el endpoint
- THEN responde 403 sin tocar MinIO ni el repo de attachments

### Requirement: MEDIA-6 — robustez (lección 504, ya aprendida en este repo)

Todo handler async que toque `ChatMessageAttachment` (webhook, endpoint de
servido) MUST resolver con un status inmediato ante error (`next(err)`),
nunca dejar el request colgado. El disparo fire-and-forget
(`ChatMediaDownloadTrigger.requestDownload`) MUST NOT propagar una excepción
dentro del request del webhook — el webhook responde 200 pase lo que pase con
el trigger. Una descarga que falla MUST NOT tumbar el scheduler (ver MEDIA-3).

#### Scenario: el repo de attachments lanza en el endpoint de servido
- GIVEN `ChatMessageAttachmentRepository.findById` lanza
- WHEN se ejecuta el handler del endpoint
- THEN responde con un status de error inmediato (`next(err)`), nunca cuelga

#### Scenario: el trigger lanza sincrónicamente dentro del webhook
- GIVEN `requestDownload(id)` lanza una excepción síncrona (bug en la impl
  infra del trigger)
- WHEN el webhook procesa un `message_created` con adjuntos
- THEN el webhook igual responde 200 (el trigger se invoca de forma
  aislada/protegida, su falla no aborta la respuesta)

---

## Contrato — Modelo `ChatMessageAttachment` (Prisma, referencia)

```prisma
model ChatMessageAttachment {
  id                   String      @id @default(uuid())
  messageId            String
  message              ChatMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
  chatwootAttachmentId Int         // idempotencia — mismo criterio que chatwootMessageId
  fileType             String      // 'image' | 'audio' | 'video' | 'file' (string plano)
  contentType          String      // MIME real reportado por Chatwoot
  filename             String?
  sizeBytes            Int?        // se expone como fileSize en el DTO
  width                Int?
  height               Int?
  storageKey           String?     // NULL mientras pending; key = messaging/{conversationId}/{id}.ext
  thumbStorageKey      String?     // solo image
  sourceUrl            String      // data_url de Chatwoot (301 estable, sin auth)
  thumbSourceUrl       String?     // thumb_url de Chatwoot, solo image
  status               String      @default("pending") // 'pending' | 'downloaded' | 'failed'
  downloadAttempts     Int         @default(0)
  lastError            String?
  createdAt            DateTime    @default(now())
  updatedAt            DateTime    @updatedAt

  @@unique([chatwootAttachmentId])
  @@index([messageId])
  @@index([status])
}
```

`ChatMessage` gana (aditivo): `attachments ChatMessageAttachment[]`.

## Contrato — DTO `ChatMessageAttachmentDto`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `string` | — |
| `fileType` | `'image'\|'audio'\|'video'\|'file'` | — |
| `contentType` | `string` | MIME real |
| `filename` | `string \| null` | — |
| `fileSize` | `number \| null` | rename de `sizeBytes` en el wire (mismo criterio que `preview`) |
| `width` | `number \| null` | — |
| `height` | `number \| null` | — |
| `status` | `'pending'\|'downloaded'\|'failed'` | para el placeholder del FE |
| `url` | `string` | BE-proxy: `/api/messaging/attachments/:id/file` |
| `thumbUrl` | `string \| null` | BE-proxy `?variant=thumb`; `null` si no aplica |

`ChatMessageDto` gana: `attachments: ChatMessageAttachmentDto[]`.

**Nunca**: `sourceUrl`, `thumbSourceUrl`, `storageKey`, `thumbStorageKey`,
`lastError`, `downloadAttempts`.

## Contrato — endpoint de servido

```
GET /api/messaging/attachments/:id/file?variant=original|thumb
```

- Auth: `auth` + `perms.read` (`messaging:read`) — igual que INBOX-1/2/3.
- `variant` default `original`; `thumb` cae a `original` si no hay
  `thumbStorageKey`.
- Respuestas: 200 (binario + `Content-Type` + `Content-Disposition` RFC
  5987), 401 (sin sesión), 403 (sin `messaging:read`), 404
  (`AttachmentNotFoundError`), 409 (`AttachmentNotReadyError`,
  `status !== 'downloaded'`).
- El binario real (MinIO, bucket `task-attachments`, prefijo `messaging/`)
  queda privado detrás del BE — nunca una URL directa al storage.

## Seguridad — qué nunca se expone

- El DTO, los logs y cualquier respuesta HTTP MUST NOT filtrar `sourceUrl`,
  `thumbSourceUrl`, `storageKey`, `thumbStorageKey` ni el `api_access_token`
  de Chatwoot.
- El follow-redirect del `data_url` MUST NOT reenviar headers de
  autenticación a un host distinto al de origen.
- El endpoint de servido resuelve el attachment SIEMPRE por su propio `id`
  vía repositorio — nunca acepta una key de storage como parámetro. Nota de
  alcance (no resuelto en esta tanda, heredado de RBAC-1..4): `messaging:read`
  es un gate global sin ACL por-conversación — el mismo posture que ya tiene
  el resto de `messaging` (INBOX-1/2/3), no una regresión nueva de esta
  feature. Un attachment sin `ChatMessage` padre es estructuralmente
  imposible (FK `onDelete: Cascade`).

---

## Test scenarios (resumen para sdd-tasks/sdd-apply, strict TDD)

1. Captura idempotente — 2 webhooks, mismo `chatwootAttachmentId` → 1 fila.
2. Reintento de webhook sobre adjunto ya `downloaded` no lo revierte a `pending`.
3. Mensaje solo-attachment (`content=''`) — se persiste igual, con su adjunto.
4. `fileType` no-binario (`location`/`contact`/`fallback`/`embed`) — no crea fila.
5. Fetch-on-open también captura adjuntos (paridad con el webhook).
6. `pending` → `downloaded` (happy path, imagen + thumbnail).
7. Tamaño excedido por `fileType` → `failed`, no sube nada, `downloadAttempts+1`.
8. Follow-redirect del `data_url` sin reenviar headers de auth cross-host.
9. Red caída/Chatwoot no responde → `markFailed` incrementa attempts + `lastError`.
10. Ya `downloaded` → no se re-descarga (idempotencia del use case).
11. Scheduler recupera un `pending` no disparado (proceso reiniciado).
12. Scheduler reintenta un `failed` con `downloadAttempts < 5`.
13. `downloadAttempts >= 5` → excluido del barrido (abandono sin loop infinito).
14. Feature flag `chat-media-download` apagado → el scheduler no barre.
15. Una descarga falla en el barrido → las demás se procesan, el scheduler sigue vivo.
16. No leak de campos internos (`sourceUrl`/`storageKey`/`lastError`/etc.) en el DTO.
17. `thumbUrl` null para tipos sin thumbnail (`video`/`audio`/`file`).
18. Endpoint 200 — sirve original.
19. Endpoint 200 — sirve thumb con fallback a original si no hay `thumbStorageKey`.
20. Endpoint 409 — `status IN (pending, failed)`.
21. Endpoint 404 — id inexistente.
22. Endpoint 403 — sin `messaging:read`.
23. Handler del endpoint no cuelga si el repo lanza (`next(err)`).
24. El trigger fire-and-forget no rompe la respuesta 200 del webhook si lanza.
25. Migración aplica limpio; FK cascade borra attachments al borrar el mensaje.

---

## Decisiones abiertas

Ninguna bloqueante: las 6 decisiones abiertas del proposal (A–F) quedaron
resueltas por las decisiones ya confirmadas del arquitecto (data_url +
follow-redirect sin auth = A; buffer serializado = B; thumbnail vía
`thumb_url` sin `ImageProcessor` = C; ruta `/file?variant=` = D; `sizeBytes`
en modelo / `fileSize` en DTO = E; ~2min + `attempts<5` = F). Una sola
aclaración para `sdd-design`, no bloqueante: confirmar que "ownership vía la
conversación" (mencionado en el brief) se satisface con la resolución por
`id` propio del attachment + FK cascade (sin ACL por-conversación nueva), tal
como se documentó en §Seguridad — si el arquitecto quiere scoping estricto
por-conversación, es un requirement adicional para una fase posterior.
