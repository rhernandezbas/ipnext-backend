# Design — messaging-inbox (F1: Inbox WhatsApp sobre Chatwoot)

Anclas verificadas contra main (2026-07-12): `app.ts` 2509 líneas, `HttpRadiusOrchestratorGateway.ts`
(:32-63), `rbac.ts` (`KNOWN_ACTIONS`:19-82, `RBAC_MODULES`:92-136), `ResolveUserPermissions.ts`:69,
`apiKeyMiddleware.ts`, `errorHandler.ts` (`statusMap`), `actions.routes.ts`+`actions.routes.test.ts`,
`matchActiveClient.ts`, `CustomerRepository.ts`:49-79, `config.ts` (patrón opt-in iclass:87-98),
`dto/pagination.ts`. Hexagonal estricta. DTOs siempre, nunca entidades Prisma crudas.

## 1. Modelos Prisma (migración aditiva)

```prisma
model Conversation {
  id                     String        @id @default(uuid())
  chatwootConversationId Int           @unique
  contactName            String?
  contactPhone           String?
  status                 String        @default("open")   // passthrough del vocabulario de Chatwoot
                                                            // (open/resolved/pending) — String plano,
                                                            // mismo criterio que Contract.status/Message.channel
  canReply               Boolean       @default(false)     // cache del can_reply de Chatwoot (ver §Decisión SEND)
  lastMessageAt          DateTime?
  lastMessagePreview     String?
  createdAt              DateTime      @default(now())
  updatedAt              DateTime      @updatedAt
  messages               ChatMessage[]

  @@index([lastMessageAt])
}

model ChatMessage {
  id                String       @id @default(uuid())
  conversationId    String
  conversation      Conversation @relation(fields: [conversationId], references: [id])
  chatwootMessageId Int          @unique   // idempotencia de upsert (HOOK-4) — id de MENSAJE de Chatwoot
  direction         String       // 'inbound' | 'outbound' — mensajes 'activity'/'template' NO se persisten (ver §7)
  content           String
  senderName        String?
  chatwootCreatedAt DateTime     // timestamp de Chatwoot — usado para ordenar (INBOX-3), NUNCA para
                                 // calcular la ventana 24h (eso lo resuelve canReply, no math local)
  createdAt         DateTime     @default(now())

  @@index([conversationId, chatwootCreatedAt])
}

model WebhookDelivery {
  id         String   @id @default(uuid())
  source     String   @default("chatwoot")
  deliveryId String   // X-Chatwoot-Delivery
  receivedAt DateTime @default(now())

  @@unique([source, deliveryId])
}
```

**Sin `clientId` en `Conversation`** (desvío deliberado del boceto original que sugería un FK cacheado):
CTX-2 exige que calcular el contexto de cliente "MUST NOT modificar... la Conversation" — persistir un
`clientId` ahí obligaría a re-escribirlo en cada fetch-on-open (o dejarlo stale entre altas/bajas de
`Client`). El contexto se **computa en cada lectura de detalle** (`GetClientContextByPhone`, ver §4), NUNCA
en el listado (evita el N+1 de `listActiveContacts()` por fila que el propio explore marcó a vigilar).

Sin FK dura `Client`→`Conversation` (el match es por teléfono normalizado, no por id).

## 2. Dedup de `X-Chatwoot-Delivery` — tabla `WebhookDelivery`, NO columna en `ChatMessage`

Una entrega de webhook puede corresponder a `conversation_created` o `conversation_status_changed` —
eventos que **no generan ninguna fila `ChatMessage`**. Una columna única en `ChatMessage` no puede
deduplicar esos dos tipos (no hay fila donde guardarla). `WebhookDelivery` desacopla la idempotencia de
ENTREGA HTTP del efecto sobre el mirror, cubriendo los 3 tipos suscritos (HOOK-4) uniformemente.
Implementación: `recordIfNew(source, deliveryId)` vía `create()` + catch `P2002` → `false` (duplicado),
sin duplicada → `true` (procesar) — mismo patrón de "unique + catch carrera" que `sourceContractId` en
`OwnershipTransferCase`.

## 3. Port `ChatwootGateway` + adapter `HttpChatwootGateway`

`src/domain/ports/ChatwootGateway.ts` — nombre corregido respecto al boceto del proposal
(`MessagingGateway`) para alinear con la convención `Http{Nombre}Gateway` ya establecida
(`HttpRadiusOrchestratorGateway`):

```ts
export interface ChatwootConversationDto {
  id: number; contactName: string | null; contactPhone: string | null;
  status: string; canReply: boolean; lastActivityAt: string | null;
}
export interface ChatwootMessageDto {
  id: number; direction: 'inbound' | 'outbound' | null; // null = filtrado por §7 (activity/template)
  content: string; senderName: string | null; createdAt: string;
}
export interface ChatwootGateway {
  listConversations(): Promise<ChatwootConversationDto[]>;
  getConversation(chatwootConversationId: number): Promise<ChatwootConversationDto>;
  listMessages(chatwootConversationId: number): Promise<ChatwootMessageDto[]>;
  sendMessage(chatwootConversationId: number, content: string): Promise<ChatwootMessageDto>;
  /** F2: no consumido por ningún use case de F1; queda en el port por completitud de contrato. */
  searchContact(query: string): Promise<{ id: number; name: string | null; phone: string | null }[]>;
  /** Invocado SOLO por `scripts/registerChatwootWebhook.ts` (setup operativo one-shot), no por app.ts. */
  registerWebhook(url: string, secret: string): Promise<void>;
}
```

`src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts` — clona `HttpRadiusOrchestratorGateway`
(:32-45): `axios.create({ baseURL, headers: { api_access_token: token } })` construido en el ctor, SIN
retry/backoff (Chatwoot corre en NUESTRO VPS `.37`, no es un 3ro flapeante como GR). A diferencia del
orchestrator (que distingue 4xx-rechazado de 5xx-inalcanzable), acá el spec (SEND-3/ROB-1) solo define UN
resultado de fallo: **cualquier error de axios (red/timeout/4xx/5xx) → `ChatwootUnavailableError`** — no
hay escenario spec para un "Chatwoot 4xx rechazó deliberadamente"; distinguirlo sería invención sin test.
Endpoints (Application API v1, `account_id=2`, `inbox_id=1`):
`GET /accounts/:id/conversations?inbox_id=1`, `GET /accounts/:id/conversations/:convId`,
`GET /accounts/:id/conversations/:convId/messages`,
`POST /accounts/:id/conversations/:convId/messages` (`{content, message_type:'outgoing'}`),
`POST /accounts/:id/webhooks` (`{url, subscriptions:['message_created','conversation_created',
'conversation_status_changed'], secret}`).

## 4. Use cases (`application/use-cases/messaging/`)

- **`ReceiveChatwootWebhook`** — deps `ConversationRepository`, `ChatMessageRepository`,
  `WebhookDeliveryRepository`. `execute(deliveryId, payload)`: `recordIfNew` primero (HOOK-3, dup → return
  sin tocar mirror); switch por `payload.event`: `message_created` → upsert `Conversation` (lastMessageAt/
  preview) + upsert `ChatMessage` (skip si `direction` mapea `null`, §7); `conversation_created` → upsert
  `Conversation` con contacto inicial; `conversation_status_changed` → update solo `status`; cualquier otro
  → no-op (HOOK-5). Nunca lanza por evento desconocido.
- **`ListConversations`** — deps `ConversationRepository.list({page, limit})` (patrón
  `dto/pagination.ts`, NO el `page/pageSize` custom de actions-worklist) → `ConversationListItemDto[]`
  ordenado por `lastMessageAt DESC`. Sin `clientContext` (evita N+1, §1).
- **`GetConversation`** (fetch-on-open, INBOX-2) — deps `ConversationRepository`, `ChatMessageRepository`,
  `ChatwootGateway`, `GetClientContextByPhone`. `execute(id)`: `findById` (404 `CONVERSATION_NOT_FOUND` si
  no existe en el mirror); `try { const live = await gateway.getConversation(chatwootId); upsert
  canReply/status/contactName/contactPhone/lastActivityAt; const msgs =
  await gateway.listMessages(chatwootId); upsert cada uno por chatwootMessageId } catch (e) { log,
  swallow }` — el catch cubre TODO el bloque de sync (INBOX-2 escenario 2: nunca 500 por esto). Devuelve
  SIEMPRE el snapshot post-intento + `clientContext` (llamada única a `GetClientContextByPhone`, la única
  ejecución de `listActiveContacts()` en todo el flujo de detalle).
- **`ListMessages`** — deps `ConversationRepository` (404 guard) + `ChatMessageRepository.listByConversation`
  ASC → `ChatMessageDto[]`.
- **`SendMessage`** (SEND-1/2/3) — deps `ConversationRepository`, `ChatMessageRepository`,
  `ChatwootGateway`. `execute(id, content)`: `findById` (404); **lee `conversation.canReply` del MIRROR**
  (cacheado por el último `GetConversation`/webhook, NUNCA recalculado con math de 24h local — decisión
  confirmada por el usuario) → `false` → `MessagingWindowExpiredError` (422) SIN llamar a Chatwoot (SEND-2,
  cubre también "nunca hubo inbound" porque Chatwoot devuelve `can_reply:false` en ese caso); `true` →
  `try { gateway.sendMessage(...) } catch { throw ChatwootUnavailableError }` (503, SEND-3, sin upsert) →
  éxito → upsert `ChatMessage` outbound + `Conversation.lastMessageAt/preview` → DTO.
- **`GetClientContextByPhone`** — deps `CustomerRepository` (port existente, reusa `listActiveContacts()` +
  `normalizePhone`/`suffixMatch` de `matchActiveClient.ts`, SIN reimplementar). `execute(contactPhone)`:
  `normalizePhone` → `null` → `{status:'unknown', clients:[]}`; si no, UNA llamada a
  `listActiveContacts()`, filtra por `suffixMatch`; 0→`unknown`, 1→`matched`, ≥2→`ambiguous`.

## 5. DTOs (`application/dto/messaging.ts`)

```ts
export interface ConversationListItemDto {
  id: string; contactName: string | null; contactPhone: string | null;
  lastMessageAt: string | null; preview: string | null; status: string;
}
export interface ConversationDetailDto extends ConversationListItemDto {
  canReply: boolean; clientContext: ClientContextDto;
}
export interface ChatMessageDto {
  id: string; direction: 'inbound' | 'outbound'; content: string;
  senderName: string | null; sentAt: string;
}
export interface ClientContextDto {
  status: 'matched' | 'unknown' | 'ambiguous';
  clients: Array<{ id: string; name: string; status: string }>;
}
```

## 6. Router `/api/messaging` + wiring HMAC/raw-body en `app.ts`

**Raw body — patrón exacto ya existente** (`app.ts:829` comment): un `express.json()` montado en un path
específico ANTES del global (`app.ts:830`) evita el re-parseo porque body-parser marca `req._body=true` y
el segundo `express.json()` global lo salta. Insertar, ANTES de `app.ts:830`:

```ts
app.use('/api/messaging/webhook', express.json({
  verify: (req, _res, buf) => { (req as Request & { rawBody?: Buffer }).rawBody = buf; },
}));
```

**Middleware HMAC** — `src/infrastructure/http/middleware/chatwootSignatureMiddleware.ts`, estilo
`apiKeyMiddleware.ts` (respuesta directa `res.status(401).json(...)`, NO pasa por `DomainError`/
`errorHandler` — mismo idioma que el resto de middlewares de auth de este repo): si
`config.chatwoot.webhookSecret` vacío → 401 cerrado; si falta `req.rawBody` → 401 `INVALID_SIGNATURE`
(fail-closed, HOOK-1 escenario 3); recompute `HMAC-SHA256(secret, `${timestamp}.${rawBody}`)` con
`crypto.createHmac` + `crypto.timingSafeEqual` (guardar longitudes iguales antes de comparar, si no
→ inválido sin throw); ventana `±5min` sobre `X-Chatwoot-Timestamp` (HOOK-2) → 401 `STALE_TIMESTAMP`.

**Router** `src/infrastructure/http/routes/messaging.routes.ts` (patrón `actions.routes.ts`: factory +
perms interface, auth aplicado POR RUTA, no a nivel router):

```ts
router.post('/webhook', chatwootSignatureMw, webhookHandler);              // SIN auth/perms — RBAC-4
router.get('/conversations', auth, perms.read, listHandler);
router.get('/conversations/:id', auth, perms.read, getHandler);
router.get('/conversations/:id/messages', auth, perms.read, messagesHandler);
router.post('/conversations/:id/messages', auth, perms.send, sendHandler);
```

Todos los handlers `async` con `try/catch → next(err)` (ROB-1). Mount en `app.ts` junto al bloque
`actions` (~:2420-2453), en su propio bloque `{ }` que construye repos Prisma + `HttpChatwootGateway`
(config-gated: si `config.chatwoot.baseUrl` vacío, el gateway igual se construye pero cualquier llamada
falla con `ChatwootUnavailableError` — no hay "flag ready" tipo Gigared en F1, decisión ya cerrada:
config estática, boot no falla).

## 7. RBAC — doble notación (colon vs dot), NO son dos registros

**No existen dos notaciones en la DB.** `RbacModule.code` y `RbacPermission.action` son DOS COLUMNAS
separadas (`code='messaging'`, `action='read'|'send'`) — nunca una string concatenada. Las "dos
notaciones" son solo dos SERIALIZACIONES de ESE MISMO par, en dos call-sites distintos:

- **Backend, colon en comentarios/tests** (`requirePerm('messaging', 'read')` — dos argumentos,
  `actions.routes.test.ts:118` usa `'actions:read'` solo como texto descriptivo del `it()`, nunca como
  valor real).
- **FE, dot en el wire**: `ResolveUserPermissions.execute()` (`rbac/ResolveUserPermissions.ts:69`)
  arma automáticamente `` `${moduleCode}.${action}` `` — con las filas `messaging`+`read`/`send` creadas
  y grant-eadas, `/me` YA devuelve `messaging.read`/`messaging.send` SIN código extra.

El riesgo real que el usuario marca CRÍTICO es hand-typear `'messaging:read'` como UN SOLO valor de
`moduleCode` (crearía un módulo falso `"messaging:read"` con `action` vacío) — la migración clona
EXACTO el patrón de 7 pasos de `20260903000000_actions_permissions` (module INSERT, permission INSERT
`SELECT ... WHERE code='messaging'`, grant INSERT por rol×acción), donde módulo y acción viajan SIEMPRE
como valores separados. `'send'` es acción NUEVA → se agrega a `KNOWN_ACTIONS` (`rbac.ts`, ~:82, sin
migración de schema porque la columna es `VARCHAR(64)` sin `ENUM`, mismo caso que `'transfer'` en
`20260901000000_service_transfer_permissions`). `'messaging'` se agrega a `RBAC_MODULES` (~:136).

## 8. Paginación

`ListConversations` usa `PaginatedQuery`/`PaginatedResult` de `dto/pagination.ts` (`page`/`limit`,
mismo contrato que `ListClients`) — NO el `page`/`pageSize` custom de actions-worklist (ese fue una
decisión aislada de ese change). `ListMessages` **sin paginación en F1** (devuelve el historial completo
ASC): ningún escenario del spec pide `page=`, un thread de WhatsApp es acotado, y agregar cursor sin caso
de uso real es invención — revisar en F2 si algún thread crece lo suficiente para justificarlo.

## 9. Config / secrets

`config.ts` (patrón opt-in `iclass`, NO en `REQUIRED_VARS`):

```ts
chatwoot: {
  baseUrl: process.env.CHATWOOT_BASE_URL ?? '',
  accountId: process.env.CHATWOOT_ACCOUNT_ID ?? '',
  apiToken: process.env.CHATWOOT_API_TOKEN ?? '',
  inboxId: process.env.CHATWOOT_INBOX_ID ?? '',
  webhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET ?? '',
},
```

`env.example`: bloque `CHATWOOT_*` con comentario inline (sin repetir el drift ya detectado en
uisp/orchestrator/minio). `deploy.yml`: 5 líneas `-e CHATWOOT_X="${{ secrets.CHATWOOT_X }}"` en el step
Deploy container (junto al bloque `MINIO_*`, `:102-107`) + `gh secret set CHATWOOT_BASE_URL/
ACCOUNT_ID/API_TOKEN/INBOX_ID/WEBHOOK_SECRET` (operativo, fuera del repo).

## Errores de dominio nuevos (`domain/errors/messaging.ts`)

| Error | code | HTTP (`statusMap`) |
|---|---|---|
| `ConversationNotFoundError` | `CONVERSATION_NOT_FOUND` | 404 |
| `MessagingWindowExpiredError` | `MESSAGING_WINDOW_EXPIRED` | 422 |
| `ChatwootUnavailableError` | `CHATWOOT_UNAVAILABLE` | 503 |

`INVALID_SIGNATURE`/`STALE_TIMESTAMP` (401) se responden DIRECTO desde el middleware HMAC (idioma
`apiKeyMiddleware`), no pasan por `DomainError`/`statusMap`.

## Archivos nuevos/tocados

**Nuevos**: `prisma/migrations/20260904000000_messaging_mirror/migration.sql`,
`prisma/migrations/20260904000100_messaging_permissions/migration.sql`,
`domain/ports/{ChatwootGateway,ConversationRepository,ChatMessageRepository,WebhookDeliveryRepository}.ts`,
`domain/errors/messaging.ts`, `infrastructure/adapters/chatwoot/HttpChatwootGateway.ts`,
`infrastructure/adapters/prisma/Prisma{Conversation,ChatMessage,WebhookDelivery}Repository.ts`,
`infrastructure/adapters/in-memory/InMemory{Conversation,ChatMessage,WebhookDelivery}Repository.ts`,
`application/dto/messaging.ts`, `application/use-cases/messaging/{ReceiveChatwootWebhook,
ListConversations,GetConversation,ListMessages,SendMessage,GetClientContextByPhone}.ts`,
`infrastructure/http/middleware/chatwootSignatureMiddleware.ts`,
`infrastructure/http/routes/messaging.routes.ts`, `scripts/registerChatwootWebhook.ts` (one-shot ops,
no wiring en `app.ts`).
**Tocados**: `prisma/schema.prisma`, `domain/entities/rbac.ts` (+`'messaging'`, +`'send'`),
`infrastructure/http/middleware/errorHandler.ts` (3 entradas `statusMap`), `infrastructure/http/app.ts`
(raw-body override antes de `:830`, mount router ~`:2420`, wiring gateway/repos), `infrastructure/
config.ts` (+bloque `chatwoot`), `env.example`, `.github/workflows/deploy.yml`.

## Testing (Strict TDD)

| Capa | Qué | Cómo |
|---|---|---|
| Unit | `ReceiveChatwootWebhook` (dedup, 3 eventos, HOOK-5 ignora, filtro activity/template) | InMemory repos |
| Unit | `GetConversation` fetch-on-open (sync ok, Chatwoot caído → swallow+200, 404) | InMemory + `ChatwootGateway` fake |
| Unit | `SendMessage` (canReply true/false, Chatwoot caído → 503 sin upsert) | InMemory + fake gateway |
| Unit | `GetClientContextByPhone` (matched/unknown/ambiguous/teléfono basura) | reusa fixtures de `matchActiveClient` |
| Middleware | HMAC (firma válida/inválida/sin rawBody, ventana ±5min, replay) | supertest con raw body real |
| Routes | RBAC (403 read/send), no-cuelgue (repo lanza → next(err)), webhook sin sesión (RBAC-4) | supertest + in-memory |
| Composition | migración corre 2 veces sin duplicar, mount router + statusMap pins | patrón `actions-worklist` |

## Open Questions

- [ ] Path JSON exacto de `contact.phone_number`/`name` en el payload real de `message_created` —
  verificar contra un webhook real de `.37` antes de escribir el mapper (riesgo #2 del proposal, sigue
  abierto).
- [ ] Confirmar que Chatwoot v4.13.0 realmente devuelve `can_reply` en `GET .../conversations/:id` (no
  solo en el webhook) — si no está ahí, `GetConversation` no puede refrescar `canReply` en el fetch-on-open
  y hay que resolverlo por otra vía antes de `sdd-apply`.
- [ ] `message_type` exacto que Chatwoot usa para notas internas/activity en el payload — mapeo a
  `direction: null` (skip) es best-effort hasta verificarlo en vivo.
