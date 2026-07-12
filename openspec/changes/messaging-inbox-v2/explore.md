# Explore — messaging-inbox-v2 (F1.5)

> Investigación READ-ONLY. Ningún archivo de código fue modificado. Repos: BE
> `ipnext-backend` (este repo) y FE `ipnext-frontend`.
>
> Contexto clave: **F1 (`messaging-inbox`) ya está shippeado** — `openspec/specs/messaging-inbox/spec.md`
> describe el contrato ya implementado (webhook HMAC, inbox paginado, fetch-on-open,
> envío dentro de ventana 24h, contexto básico por teléfono, RBAC read/send). F1.5 es
> la iteración de valor sobre esa base, NO un rediseño desde cero.

## Estado actual (base F1 ya en prod)

- **Mensaje**: solo texto. `ChatMessage` (schema) no tiene ningún campo de adjunto.
  `ChatMessageDto`/`WhatsappMessage` (BE y FE) solo tienen `content: string`.
- **Gateway Chatwoot**: `HttpChatwootGateway.sendMessage(id, content)` — un solo
  parámetro de contenido, sin `attachments`/`private`. El mapper `toMessageDto`
  hace `content: r.content ?? ''` y **no lee ningún campo de adjunto** del raw
  payload porque `RawChatwootMessage` no lo declara — no es que se descarte
  activamente, es que el tipo nunca lo contempló.
- **Webhook**: `ChatwootWebhookPayload` (`ReceiveChatwootWebhook.ts`) tampoco
  declara `attachments`. El comment del archivo dice que el resto de los campos
  fue "VERIFIED against a live `.37` message_created webhook" — pero esa
  verificación NO incluyó un mensaje con adjunto, así que hoy no sabemos la forma
  real del campo `attachments` en este tenant de Chatwoot v4.13.0.
- **Estado de conversación**: SÍ existe (`Conversation.status`, default `'open'`,
  pasa por `conversation_status_changed` del webhook) y SÍ se pinta en el FE
  (`ConversationListItem` con `StatusBadge` open/pending/resolved). Lo que
  **falta** es la dirección inversa: ningún use case permite que un agente de
  Prominense cambie el estado (resolve/reopen) — hoy el estado solo se actualiza
  cuando cambia DESDE Chatwoot.
- **Notas privadas**: el pipeline YA filtra `private:true` en ambos caminos
  (webhook y fetch-on-open) para que nunca ensucien el mirror ni el preview. Pero
  es un filtro de LECTURA únicamente — no hay forma de que un agente ESCRIBA una
  nota privada desde Prominense (`SendMessage.execute` no tiene un parámetro
  `private`).
- **Filtros/asignación**: `Conversation` no tiene ningún campo de asignación
  (`assigneeId` no existe en el mirror). `ConversationRepository.list()` solo
  acepta `{page, limit}` — no hay filtro por status ni por asignado. Tabs
  Mine/Unassigned/All no son posibles hoy ni siquiera a nivel de query.
- **Contexto de cliente**: `GetClientContextByPhone` matchea por teléfono contra
  `listActiveContacts()` y devuelve `{id, name, status:'active'}` — nada más. El
  panel FE (`ClientContextPanel`) solo pinta nombre + link "Ver perfil →".

## Grupo A — Media (adjuntar/recibir fotos, video, archivos)

**Valor**: alto (comprobantes de pago, fotos de antena/instalación — casos de uso
reales del día a día IPNEXT).

### Qué existe hoy (0% de lo necesario en messaging, pero SÍ existe un patrón clonable)

No hay NADA de media en messaging. Pero el repo tiene un patrón COMPLETO y maduro
para adjuntos binarios: **task-photos** (fotos de `ScheduledTask`), que resuelve
exactamente el mismo problema (subir, listar, servir, borrar binarios) y puede
clonarse casi 1:1:

- `prisma/schema.prisma` → `model ScheduledTaskAttachment` (`storageKey`,
  `filename`, `mimeType`, `sizeBytes`, `width`/`height` opcionales,
  `uploadedById`).
- `src/domain/ports/FileStorage.ts` — port `save/get/delete` por `key`, agnóstico
  del storage concreto.
- `src/infrastructure/adapters/minio/MinioFileStorage.ts` — adapter real (MinIO
  en `.37`, credenciales en `CREDENCIALES-LOCAL.md`).
- `src/infrastructure/adapters/in-memory/InMemoryFileStorage.ts` — para tests.
- `src/infrastructure/http/routes/taskAttachments.routes.ts` — multer
  (memoryStorage, 10 MiB/archivo, 15 archivos), content-disposition RFC 5987
  seguro, endpoints `POST .../attachments` (multipart, campo `photos`),
  `GET .../attachments/:id/file?variant=thumb|original`, `DELETE`.
  `AttachPhotosToTask` (use case, no leído en detalle pero referenciado) hace el
  guardado + validación de tipo/tamaño/cantidad.
- Errores tipados en `src/domain/errors/taskAttachment.ts`:
  `UnsupportedAttachmentTypeError` (415), `TooManyAttachmentsError` (422),
  `AttachmentNotFoundError` (404), `ImageTooLargeError` (422, anti
  decompression-bomb), `StorageNotConfiguredError` (503 si faltan las `MINIO_*`
  — la feature DEGRADA, no rompe el boot).
- FE: `TaskPhotosGallery.tsx` (grid + lightbox accesible con focus-trap +
  `Escape` + `prefers-reduced-motion`, upload con `<input type="file" multiple>`,
  feedback de éxito/error auto-dismiss) + `taskAttachments.api.ts` (FormData
  multipart) + `useTaskAttachments.ts` + `mapUploadError.ts`. Directamente
  clonable para el composer y el bubble de WhatsApp.

### Qué falta

**BE:**
1. Campo(s) de adjunto en `ChatMessage` (mirror) — `mediaUrl`/`mediaMimeType`/
   `mediaFilename` o una tabla `ChatMessageAttachment` separada (ver decisión
   abierta más abajo, 1:1 vs 1:N).
2. `ChatwootWebhookPayload.attachments` — declarar el campo y mapearlo en
   `ReceiveChatwootWebhook.handleMessageCreated` (persistir junto al mensaje).
   **Bloqueado en la forma exacta hasta verificar el payload real** (ver Open
   Questions).
3. `RawChatwootMessage`/`ChatwootMessageDto` (gateway + port) — declarar
   `attachments` para que el fetch-on-open (`GetConversation.syncFromChatwoot`)
   también los traiga.
4. `HttpChatwootGateway.sendMessage` — hoy solo manda `content`; para ENVIAR
   media hay que decidir si Chatwoot acepta multipart (`files[]`) en
   `POST .../messages` (patrón típico de Chatwoot, no verificado en este
   tenant) y si el BE hace de proxy (recibe multipart de Prominense → reenvía a
   Chatwoot) o si primero sube a MinIO y solo pasa una URL.
5. Nuevos endpoints/params en `messaging.routes.ts` (`POST
   .../conversations/:id/messages` con multipart, o un endpoint separado
   `/messages/media`).
6. Errores tipados (clonar `taskAttachment.ts`: tipo no soportado, tamaño,
   storage no configurado).

**FE:**
1. Botón de adjuntar (📎) en `Composer.tsx` + file picker (clon de
   `TaskPhotosGallery`'s input).
2. Render de media en `MessageBubble.tsx` — hoy solo `<span>{message.content}</span>`;
   necesita `<img>`/`<video>`/`<audio>`/enlace de descarga según
   `mimeType`, + lightbox (reusar el de `TaskPhotosGallery`).
3. `WhatsappMessage` (types) — agregar campo(s) de adjunto.
4. `whatsapp.api.ts` — `sendWhatsappMessage` pasa a aceptar FormData cuando hay
   archivo (mismo patrón que `uploadTaskAttachments`).

### Esfuerzo: **Alto**
Toca mirror (migración Prisma), gateway, webhook mapper, ruta de envío, Y el FE.
El patrón task-photos reduce mucho el riesgo de diseño, pero sigue siendo la
superficie más grande de las 4.

### Dependencias
- El FE de media (render + composer) depende de que el BE tenga attachments en
  el mirror y el DTO — **no se puede paralelizar completamente**, aunque el FE
  puede empezar con el componente de UI contra un mock mientras el BE cierra el
  contrato exacto.
- Requiere decisión de storage ANTES de tocar código (Chatwoot-hosted vs MinIO
  propio — ver Open Questions).
- Requiere ver un payload real de Chatwoot con adjunto (mensaje entrante con
  foto) para saber la forma exacta de `attachments[]` en este tenant — el
  propio código ya documenta que las asunciones previas fueron "best-effort...
  no se pudo verificar en vivo" para otros campos; acá aplica lo mismo y es
  bloqueante, no cosmético.

---

## Grupo B — Contexto rico del cliente (EL diferenciador)

**Valor**: muy alto — esto es lo que Chatwoot NO tiene (es un helpdesk genérico,
no conoce PPPoE/GR/facturación). Mayormente FE consumiendo endpoints que YA
existen.

### Qué existe hoy

Una vez que `GetClientContextByPhone` resuelve `status: 'matched'` con un
`clientId`, el BE YA tiene use cases listos para traer:

| Dato | Use case (ya existe) | Repo/fuente |
|---|---|---|
| Deuda / balance | `GetClientDetail` (`Customer.balanceDue`, con refresh on-demand vía `RefreshClientBalanceIfStale` si hay `grClienteId`, TTL-gated, nunca tira si GR está caído) | `CustomerRepository.findById` |
| Contratos/servicios | `GetClientContracts` (`repo.listContracts(clientId)` → `Contract[]`) — `GetClientServices` es un re-export literal del mismo (ya unificados) | `CustomerRepository.listContracts` |
| Facturas | `GetClientInvoices` (`repo.listInvoices(clientId)` → `Invoice[]`) | `CustomerRepository.listInvoices` |
| Historial / bitácora | `GetClientLogs` (paginado, `ClientLog[]`) | `CustomerRepository.listLogs` |
| Comentarios | `GetClientComments` (existe, no leído en detalle) | — |
| Stats agregados | `GetClientStats` (`repo.stats()` → `ClientStats`, probablemente conteos globales, no por-cliente — confirmar en design) | — |
| Tickets del cliente | `ListTickets` con `query.customerId` — **YA soporta filtro por cliente** (`Ticket.customerId` FK real en schema) | `TicketRepository.list` |
| Tareas del cliente | `ScheduledTask.customerId` FK existe en schema (con `contractId` también) — falta confirmar si hay un `ListScheduledTasks` con filtro `customerId` expuesto vía ruta (no verificado en este batch, alta probabilidad de que sí exista dado el patrón de Ticket) |
| PPPoE / estado de conexión | Existe todo un dominio PPPoE (`GetPppoeCredentials`, `ListPppoeByContract`, `InspectPppoeDevices`, etc.) — atable por `contractId` (que a su vez cuelga de `clientId` vía `GetClientContracts`) |

**Conclusión clave**: el Grupo B NO necesita mucho trabajo nuevo de BE. La pieza
que falta es una sola: un endpoint/agregador que, dado un `clientId` ya
resuelto por `GetClientContextByPhone`, junte estos datos en un solo payload
para el panel (evitar que el FE dispare 6 requests separados por conversación
abierta).

### Qué falta

**BE (chico):**
1. Extender `ClientContextDto`/`GetClientContextByPhone` — o agregar un nuevo
   use case `GetClientContextDetail(clientId)` que orqueste
   `GetClientDetail`+`GetClientContracts`+`GetClientInvoices`(resumen)+`ListTickets`
   (abiertos)+PPPoE state, devolviendo un DTO compuesto. Mantener
   `GetClientContextByPhone` liviano (solo el match) y resolver el detalle rico
   en un segundo request lazy (cuando el agente hace click en el cliente
   matched), para no penalizar el fetch-on-open de CADA apertura de conversación
   con 6 queries.
2. Confirmar existencia de "tareas por cliente" con filtro `customerId` (si no
   existe como use case propio, es un `where` chico sobre `ScheduledTaskRepository`).

**FE (la mayor parte del trabajo):**
1. Rediseñar `ClientContextPanel.tsx` — hoy son 3 estados chicos (avatar +
   nombre + link). Necesita secciones: deuda/balance, contrato(s) activo(s),
   estado PPPoE, tickets abiertos, próxima tarea agendada, accesos directos.
2. Puede clonar visualmente `CustomerCard.tsx` (`SchedulingTaskDetailPage`) que
   YA tiene el patrón de "ContactRow" con loading states.

### Esfuerzo: **Medio** (mayormente FE + un agregador BE chico sobre use cases existentes)

### Dependencias
- Depende de que el match de `GetClientContextByPhone` siga funcionando (no
  toca esa lógica).
- Ninguna dependencia dura con el Grupo A — se puede hacer en paralelo.
- Buen candidato para ir PRIMERO: bajo riesgo (reutiliza use cases probados),
  altísimo valor diferencial, sin tocar el pipeline de Chatwoot.

---

## Grupo C — Productividad (canned responses, resolver/reabrir, filtros, asignar)

**Valor**: medio-alto, mejora el día a día del agente pero no es lo que distingue
a Prominense (Chatwoot ya lo tiene bien).

### Qué existe hoy
- `Conversation.status` existe y se lee/pinta, pero **no hay ruta ni use case
  para que el agente lo cambie** desde Prominense.
- No hay concepto de "canned responses" en ningún lado del BE.
- No hay `assigneeId` en `Conversation` — cero soporte de datos para
  Mine/Unassigned/All.
- `ConversationRepository.list()` no acepta ningún filtro además de paginación.

### Qué falta

**BE:**
1. **Resolver/reabrir**: nuevo use case `ChangeConversationStatus` que llame al
   endpoint de Chatwoot (`toggle_status` en la Application API — **no
   verificado contra este tenant**, asumido por documentación pública de
   Chatwoot) y luego upsertee el `status` en el mirror. Clona el patrón de
   `SendMessage` (mismo error `ChatwootUnavailableError` en fallo, mismo guard
   de "no tocar el mirror si Chatwoot falla").
2. **Canned responses**: dos approaches — (a) el BE expone un endpoint
   passthrough que llama a `GET /canned_responses` de Chatwoot y el FE los
   inserta al tipear `/`, sin persistir nada localmente; o (b) directamente el
   FE no necesita al BE para esto SI Chatwoot expone esa API con CORS/token
   utilizable desde el browser (poco probable y mala práctica exponer el
   `api_access_token` al FE — mejor mantenerlo detrás del BE como con todo lo
   demás).
3. **Asignación/filtros**: agregar `assigneeId`/`assigneeName` al mirror
   (sincronizado desde `conversation.meta.assignee` del webhook/GET, si
   Chatwoot lo manda — no verificado) + extender `ConversationRepository.list()`
   con filtros `status`/`assigneeId`/`mine` (requiere saber quién es "yo" en
   términos de Chatwoot agent, lo cual es un mapeo RbacUser↔Chatwoot-agent que
   HOY NO EXISTE — riesgo de scope creep si Prominense no tiene ese vínculo).

**FE:**
1. Botón Resolver/Reabrir en el header del thread.
2. Autocompletar de canned responses al tipear `/` en el composer.
3. Tabs Mine/Unassigned/All + filtros sobre `ConversationList.tsx`.

### Esfuerzo: **Medio-Alto** (el sub-punto de asignación es el más caro porque
requiere resolver la identidad agente-Chatwoot ↔ agente-Prominense, que hoy no
existe en ningún lado del código revisado)

### Dependencias
- Resolver/reabrir es independiente y BARATO (clona `SendMessage`) — se puede
  separar del resto de Grupo C y hacer temprano.
- Canned responses depende de decidir si Chatwoot expone csv/plantillas por
  cuenta o por inbox (afecta el passthrough).
- Asignación/filtros es el ítem MÁS incierto del faseo completo — recomendado
  dejarlo para el final o directamente fuera de F1.5 hasta confirmar que
  Prominense mapea agentes 1:1 con Chatwoot.

---

## Grupo D — Rich UX (nota privada, agrupar por fecha, emoji, avatares)

**Valor**: bajo-medio, pulido de experiencia. Mayormente FE puro.

### Qué existe hoy
- El pipeline YA filtra notas privadas en lectura (nunca aparecen en el thread
  ni en el preview) — la ÚNICA pieza real de BE nueva es habilitar la
  ESCRITURA de una nota (agregar `private?: boolean` a `SendMessage.execute` y
  pasarlo a `gateway.sendMessage`).
- Avatares: `ConversationListItem` ya calcula iniciales (`initialsOf`) — patrón
  reusable para el thread.
- Agrupar por fecha / emoji picker: 100% FE, sin tocar el BE en absoluto.

### Qué falta

**BE (mínimo):**
1. `SendMessage.execute(conversationId, content, { private })` → pasa
   `message_type`/`private` al gateway. Requiere que
   `HttpChatwootGateway.sendMessage` acepte un flag y lo mande en el POST
   (`private: true` es el campo documentado por Chatwoot para notas internas
   — no verificado contra este tenant, pero es un campo simple y de bajo
   riesgo si falla: peor caso, el mensaje se manda público en vez de privado,
   fácil de detectar en QA).

**FE:**
1. Tabs Reply vs Private Note en el composer (clon directo del patrón visual
   de Chatwoot, sin nada nuevo conceptualmente).
2. Separadores de fecha en `MessageThread.tsx` (no leído en detalle, pero es
   agrupar `messages` por día — lógica pura, sin red).
3. Emoji picker en el composer (librería nueva o set curado — decisión de
   producto, no arquitectónica).

### Esfuerzo: **Bajo** (privado interno es el único ítem con BE, y es chico;
el resto es CSS/lógica de presentación)

### Dependencias
- Ninguna dependencia dura con los otros 3 grupos.
- Nota privada comparte el mismo endpoint que SEND-1/2/3 (extiende
  `SendMessage`, no crea uno nuevo) — bajo riesgo de regresión si se testea
  bien el path existente (ventana 24h, Chatwoot caído).

---

## Faseo propuesto (resumen)

| Orden | Grupo | Por qué en ese lugar |
|---|---|---|
| 1 | **B — Contexto rico** | Máximo valor diferencial, mínimo riesgo: reutiliza use cases YA probados en prod (`GetClientDetail`, `GetClientContracts`, `GetClientInvoices`, `ListTickets` con `customerId`). Cero cambios al pipeline de Chatwoot/webhook — no puede romper nada del F1 que ya está en prod. Mayormente FE. |
| 2 | **D — Nota privada (BE mínimo) + agrupar por fecha/avatares (FE)** | Extiende `SendMessage` sin tocar el mirror ni el webhook. Bajo esfuerzo, cierra brechas de confianza del agente (poder dejar una nota interna) antes de invertir en media. |
| 3 | **A — Media** | Alto valor pero alto esfuerzo y con una dependencia dura: requiere verificar en vivo el payload real de Chatwoot con adjuntos ANTES de diseñar el mirror/mapper (si no, se repite el patrón "best-effort sin verificar" que el propio código ya viene arrastrando de F1 en otros campos). Bloqueante técnico real, no solo orden de prioridad. |
| 4 | **C — Resolver/Reabrir (barato) ahora; canned responses y asignación/filtros después o fuera de F1.5** | Resolver/reabrir es barato y puede subirse de prioridad si se quiere (clona `SendMessage`). Asignación/filtros requiere resolver la identidad agente↔Chatwoot que hoy no existe — no lo golpearía sin antes confirmar con el arquitecto si Prominense necesita ese mapeo o si "Mine" no aplica en este dominio (¿los agentes de soporte son individuales o es una bandeja compartida?). |

**Nota de riesgo transversal**: TODO el código de messaging (`HttpChatwootGateway`,
`ReceiveChatwootWebhook`) documenta explícitamente en sus propios comments que
partes del mapeo (`can_reply`, `meta.sender`, `private`) fueron "best-effort...
no se pudo verificar en vivo durante este batch" en F1. Antes de picar código de
F1.5, especialmente Grupo A, conviene una sesión de verificación en vivo contra
Chatwoot en `.37` (mandar un WhatsApp con foto de prueba y capturar el webhook
crudo) — el propio orquestador señaló que esto lo hace él, no esta fase de
exploración.

---

## Decisiones abiertas (para `sdd-propose`)

1. **Media: ¿Chatwoot-hosted o MinIO propio?**
   - Chatwoot-hosted: el mirror solo guarda la URL que Chatwoot expone
     (`data_url`/`thumb_url`), el BE actúa de puro passthrough. Menos
     infraestructura propia, pero depende de que Chatwoot siga sirviendo esas
     URLs indefinidamente (¿tienen expiración? ¿requieren el `api_access_token`
     para verse, o son públicas? — no verificado).
   - MinIO propio: el BE descarga el adjunto de Chatwoot una vez y lo
     re-sube a MinIO (mismo patrón que `MinioFileStorage` de task-photos),
     sirviendo por key propia. Más control y consistencia con el patrón
     existente, pero más trabajo (descarga + re-subida + storage propio para
     algo que Chatwoot ya aloja).
   - Recomendación tentativa (a validar con el arquitecto): clonar el patrón
     MinIO existente para ENVÍO (Prominense → Chatwoot, el BE ya tiene que
     tener el binario en memoria vía multer de todos modos) pero evaluar
     passthrough de URL para RECEPCIÓN (Chatwoot → Prominense) si sus URLs
     son estables, para no duplicar storage de algo que ya llegó alojado.

2. **¿Cuánto contexto rico mostrar de una?** — ¿el panel llama a
   deuda+contratos+facturas+tickets+tareas+PPPoE TODO junto al abrir la
   conversación (1 agregador, más simple) o progresivo/lazy por sección
   (mejor performance percibida, más componentes)? Afecta si `GetClientContextByPhone`
   se extiende o si se crea un use case nuevo separado.

3. **¿Qué canales de media soporta WhatsApp vía Chatwoot realmente?** — imagen/
   video/audio/documento son los 4 tipos de WhatsApp Business API, pero hay que
   confirmar límites de tamaño de Meta (16MB video/audio, 100MB documento) vs
   los límites que YA impone `taskAttachments.routes.ts` (10 MiB) — probablemente
   necesiten límites propios más generosos para video, no reusar la constante
   tal cual.

4. **Resolver/reabrir y canned responses: ¿existe `toggle_status` y
   `canned_responses` en la Application API de ESTE Chatwoot v4.13.0?** — la
   documentación pública de Chatwoot los tiene, pero nada en este código los
   verificó en vivo (a diferencia de `message_created` que sí tiene el sello
   "VERIFIED"). Mismo caveat que Grupo A: requiere una prueba en vivo antes de
   comprometerse al diseño exacto del gateway.

5. **Identidad agente Prominense ↔ agente Chatwoot** — necesaria para "Mine"
   (Grupo C). No se encontró ningún mapeo `RbacUser.chatwootAgentId` (ni
   similar) en el schema revisado. Si no existe, hay que decidir: ¿se agrega
   ese vínculo, o "Mine" no tiene sentido en el modelo actual (bandeja
   compartida, sin agentes individuales en Chatwoot)?

## Archivos relevantes (para referencia de `sdd-propose`)

**BE:**
- `src/application/dto/messaging.ts`
- `prisma/schema.prisma` (`model Conversation`, `model ChatMessage`, `model ScheduledTaskAttachment` como referencia)
- `src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts`
- `src/domain/ports/ChatwootGateway.ts`
- `src/application/use-cases/messaging/{ReceiveChatwootWebhook,GetConversation,SendMessage,ListConversations,GetClientContextByPhone}.ts`
- `src/domain/ports/ConversationRepository.ts`
- `src/infrastructure/http/routes/messaging.routes.ts`
- `src/domain/errors/messaging.ts`
- Patrón clonable de media: `src/domain/ports/FileStorage.ts`,
  `src/infrastructure/adapters/minio/MinioFileStorage.ts`,
  `src/infrastructure/http/routes/taskAttachments.routes.ts`,
  `src/domain/errors/taskAttachment.ts`
- Use cases reusables para contexto rico: `GetClientDetail.ts`,
  `GetClientContracts.ts`, `GetClientInvoices.ts`, `GetClientLogs.ts`,
  `GetClientStats.ts`, `ListTickets.ts` (filtro `customerId`)
- Credenciales MinIO: `CREDENCIALES-LOCAL.md`

**FE:**
- `src/pages/whatsapp/WhatsappInboxPage/components/{Composer,MessageBubble,ClientContextPanel,ConversationList,ConversationListItem,MessageThread}.tsx`
- `src/types/whatsapp.ts`, `src/api/whatsapp.api.ts`, `src/hooks/useWhatsapp.ts`
- Patrón clonable de media: `src/pages/scheduling/SchedulingTaskDetailPage/components/TaskPhotosGallery.tsx`,
  `src/api/taskAttachments.api.ts`, `src/hooks/useTaskAttachments.ts`,
  `src/utils/mapUploadError.ts`
- Patrón clonable de contexto rico: `src/pages/scheduling/SchedulingTaskDetailPage/components/CustomerCard.tsx`
