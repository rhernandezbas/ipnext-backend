# Exploration: messaging-bulk (F2 del EPIC "Mensajería omnicanal WhatsApp en Prominense")

**Change**: messaging-bulk
**Project**: ipnext-backend
**Phase**: explore
**Status**: completo — insumo para proposal. Dos incógnitos grandes SIN cerrar (nodo, templates).

---

## (a) Resumen ejecutivo

F1/F1.5 (inbox Chatwoot) están en prod y dan una base sólida para reusar: gateway HTTP a Chatwoot,
mirror local `Conversation`/`ChatMessage`, `SendMessage` (envío dentro de ventana 24h), webhook de
entrada, RBAC `messaging.read`/`messaging.send`, y un matcher de teléfono (`normalizePhone`/
`suffixMatch`) ya probado en producción (recaptación + contexto de inbox). El patrón de batch
async+resumible (`ServiceCutBatch`/`ServiceCutRunner`) y el retry-con-backoff 429-aware
(`GestionRealClient`) también son reusables como MOLDE, pero ninguno de los dos calza 100%: el
batch existente no tiene notion de "rate limit sostenido" (~80/s), solo reintento reactivo tras un
429 puntual, y el throttle de GR es reactivo (retry-after-fail), no un limitador proactivo (token
bucket).

Hay dos huecos estructurales que definen el diseño de F2:

1. **`Client` no tiene FK a nodo.** Los 3 caminos candidatos (PPPoE→NAS, UISP vía MAC, tareas de
   RED) son TODOS derivados/heurísticos, ninguno es un dato directo, y el más "directo" (PPPoE→NAS)
   da la granularidad EQUIVOCADA (BRAS/router, ~4-5 nodos, no antena/sitio real, que son decenas).
2. **El envío bulk fuera de ventana 24h requiere templates de Meta vía Twilio Content API — y ESE
   camino no existe en el código.** El `ChatwootGateway` port solo tiene `sendMessage` (texto/JSON o
   multipart, siempre dentro de una conversación YA EXISTENTE en el mirror). No hay
   `createConversation`/`createContact`, no hay ningún `ContentSid`/Twilio directo en el repo — todo
   pasa por la Application API de Chatwoot v1, que (según lo verificado) no expone templates.

RBAC: `messaging.bulk`/`messaging.templates` **NO existen** — fueron bocetados en BACKLOG y
explícitamente pateados a F2 en el proposal de F1 (`archive/2026-07-12-messaging-inbox/proposal.md:56`).
Opt-out/consentimiento: **no existe ningún campo** en `Client` ni afín — hay que crearlo desde cero
(gap de compliance duro, WhatsApp Business lo exige).

---

## (b) Hallazgos por área (con evidencia)

### 1. Infra de mensajería reusable para OUTBOUND

- **Port**: `src/domain/ports/ChatwootGateway.ts:88-139`. Métodos: `listConversations`,
  `getConversation`, `listMessages`, `sendMessage(chatwootConversationId, content, files?, options?)`,
  `searchContact(query)` (línea 110, comentario propio: **"F2: not consumed by any F1 use case; kept
  in the port for contract completeness"** — ya estaba pensado para F2 pero nunca usado), `registerWebhook`,
  `setStatus`, `downloadAttachment`.
- **Adapter**: `src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts`. `sendMessage` (líneas
  164-202) hace POST a `/conversations/:id/messages` — **siempre necesita un `chatwootConversationId`
  YA EXISTENTE**. No hay método para crear una conversación nueva a partir de un teléfono/contacto.
  Timeout 60s, `maxBodyLength` 200MB (líneas 20-29), sin retry/backoff (comentario línea 73-77: "Chatwoot
  corre en nuestro VPS .37, no es un 3ro flapeante" — un solo intento, cualquier falla → `ChatwootUnavailableError`).
- **`SendMessage` use case**: `src/application/use-cases/messaging/SendMessage.ts:86-222`. Guard order
  pinneado (líneas 53-63): 1) `conversationRepo.findById` → 404 si no existe, 2) `!canReply` → 422
  `MessagingWindowExpiredError` (la ventana 24h se LEE del mirror — `Conversation.canReply` — NUNCA se
  recalcula localmente, línea 49-51), 3) valida attachments, 4) `gateway.sendMessage`.
  **Implicación crítica para bulk**: `SendMessage` asume conversación existente y ventana abierta. NO
  sirve tal cual para el primer contacto masivo (sin conversación previa, fuera de ventana por diseño —
  ahí es donde entra el template). Si SIRVE tal cual para reenganchar una respuesta del cliente al
  bulk (una vez que contesta, cae en el inbox F1 "gratis", tal como dice el contexto del change).
- **Webhook**: `ReceiveChatwootWebhook.ts:111-251`. Upsert de `Conversation`/`ChatMessage` idempotente
  por `chatwootMessageId`/delivery id. Reusable sin cambios: una respuesta a un template bulk entra
  por el mismo camino que cualquier inbound de WhatsApp.
- **Modelos**: `Conversation` (`prisma/schema.prisma:2762-2799`), `ChatMessage` (`2802-2824`),
  `ChatMessageAttachment` (`2833-2857`). `Conversation.assigneeId`/`areaId` son locales (F1.5-C2,
  líneas 2777-2787) — si el bulk asigna conversaciones a un área ("Bulk"/"Campañas"), ese campo ya
  soporta la escritura vía `updateLocalFields` (`ConversationRepository.ts:96-99`).
- **Matcher de contexto**: `GetClientContextByPhone.ts` usa `normalizePhone`/`suffixMatch` verbatim
  (línea 3, comentario "SIN reimplementar").

**Conclusión área 1**: se reusa 100% el mirror (`Conversation`/`ChatMessage`), el webhook, y RBAC
pattern. `SendMessage` sirve como pieza SOLO para el sub-caso "responder dentro de ventana" (poco
común en un primer envío bulk). El worker de campaña necesita un **caso de uso nuevo** que:
(a) ubique o cree la conversación por teléfono, (b) mande el PRIMER mensaje via template (Twilio
Content API, fuera del alcance de `ChatwootGateway` hoy), (c) recién ahí puede reusar el resto del
mirror. `ChatwootGateway.searchContact` (ya en el port, nunca invocado) es lo más cercano a
"encontrar contacto existente por teléfono" pero solo busca, no crea conversación.

### 2. El problema del NODO (crítico) — ver tabla en (c)

### 3. Segmentación por ESTADO

- `ClientStatus` enum: `active | late | blocked | inactive | baja` (`schema.prisma:221-227`).
- `Client.balanceDue Decimal? @db.Decimal(12,2)` (`schema.prisma:184`) — null hasta el primer fetch,
  0 = sin deuda. Deriva de GR, TTL-gateado (`PrismaCustomerRepository.ts:8-19`, `isBalanceStale`).
- **`ListClients`** (`src/application/use-cases/ListClients.ts`) delega en
  `CustomerRepository.list(query)`. `ListClientsQuery` (`domain/ports/CustomerRepository.ts:4-7`) **HOY
  solo soporta `search` y `status`** — NO hay filtro por `balanceDue`/deudor en el query de listado
  (el status `late` ya implica "deudor" a nivel enum, pero no hay filtro por MONTO ni por rango).
- `CustomerRepository.stats()` (línea 62) devuelve conteos por status (`ClientStats`, línea 26-33) —
  reusable para mostrar "cuántos clientes hay en cada segmento" antes de lanzar el bulk.
- `toCustomer()` (`PrismaCustomerRepository.ts:21-59`) ya calcula `balanceStale`/`isDebtor` —
  el segment builder de F2 puede apoyarse en la MISMA función para el filtro "deudor real" (status='late'
  Y balance fresco), en vez de reinventar la regla.

**Conclusión área 3**: el enum y el campo existen y están limpios; el FILTRO por status en el repo
existe; falta ampliar `ListClientsQuery`/el WHERE de Prisma para (a) status IN [...] (multi-select,
hoy es un solo string) y (b) rango/umbral de `balanceDue`. Extensión aditiva, bajo riesgo.

### 4. Templates (Meta/Twilio) — GAP confirmado, no inventado

- Grep exhaustivo de `Twilio|ContentSid|content_sid|whatsapp:` en `src/`: **0 resultados**. Todo lo
  que existe sobre templates vive en `BACKLOG.md` (línea 40, boceto de mejoras: "variables en
  templates") y en docs de `openspec/` — nunca en código.
- El `ChatwootGateway` actual habla EXCLUSIVAMENTE la Application API v1 de Chatwoot
  (`/api/v1/accounts/{id}/conversations|messages|contacts|webhooks`, `HttpChatwootGateway.ts:120-122`).
  Esta API no tiene ningún endpoint de templates en lo mapeado por este adapter.
- Para mandar un template aprobado por Meta fuera de la ventana de 24h hace falta la **Content API
  de Twilio** (`ContentSid` + variables, canal WhatsApp), que es una superficie DISTINTA a la
  Application API de Chatwoot. Dos caminos posibles, ninguno implementado hoy:
  - **(A) Chatwoot como intermediario**: Chatwoot v4.13+ soporta "message templates" para el canal
    WhatsApp/Twilio en su propia UI/API — pero no hay evidencia en este repo de que la instancia
    `.37` tenga la integración de templates configurada, ni de que la Application API v1 (la que
    consume `HttpChatwootGateway`) exponga un endpoint de templates verificado. Requiere spike contra
    la instancia real.
  - **(B) Twilio directo**: pegarle a la Content API de Twilio (`ContentSid`+variables) SIN pasar por
    Chatwoot para el primer envío, y dejar que la RESPUESTA del cliente entre por el webhook de
    Chatwoot de siempre (Twilio→Chatwoot inbound ya funciona en prod). Esto implica un adapter nuevo
    (`TwilioContentGateway` o similar) y reconciliar el mensaje saliente con el mirror `ChatMessage`
    sin pasar por `sendMessage` de Chatwoot (Chatwoot necesitaría enterarse igual, sea por su propio
    webhook de "outgoing" si lo dispara al ver el mensaje de Twilio, o por un upsert manual desde
    Prominense).
- **No se puede confirmar/descartar ninguna de las dos sin spike contra la instancia real de
  Chatwoot en `.37`** (mismo patrón de duda ya dejado abierto en el diseño de F1:
  `HttpChatwootGateway.ts:79-82`, "best-effort hasta verificarlo contra un webhook/response real").

**Conclusión área 4**: gap total, no hay código que resolver ni parcialmente — es 100% construcción
nueva + una decisión arquitectónica (A vs B) que necesita datos de la instancia real de Chatwoot/Twilio
antes del proposal.

### 5. Batch async + throttle — patrones a clonar

- **`ServiceCutBatch`** (`domain/entities/serviceCutBatch.ts:20-30`): `id`, `action`, `status`
  (`pending|running|done|failed`), `total`, `doneCount`, `failedCount`, `result: ServiceCutItemResult[]`
  (por-item, con `ok`/`error`), `createdAt`/`finishedAt`. Molde DIRECTO para `Campaign`/
  `CampaignRecipient` (mismo shape: header con contadores + array de resultados por destinatario).
- **`ServiceCutBatchRepository`** (`domain/ports/ServiceCutBatchRepository.ts`): `create`, `findById`,
  `update` (patch parcial, snapshot completo — "last-write-wins", línea 13). Mismo patrón para
  `CampaignRepository`.
- **`ServiceCutRunner`** (`infrastructure/scheduling/ServiceCutRunner.ts:24-74`): lock distribuido
  (`DistributedLock.tryAcquire`, línea 13/39 — **un solo batch a la vez, en todo el cluster**),
  `start()` rápido (crea el batch, dispara `run()` fire-and-forget, devuelve `batchId` para pollear),
  `run()` delega en un `BulkEnforcer` (interfaz estructural, línea 8) — mismo molde para un
  `BulkMessageSender`. **Gotcha a decidir para F2**: ¿un solo batch de campaña a la vez GLOBAL (como
  hoy en cortes) o N campañas en paralelo con locks por-campaña? El patrón actual asume single-lock
  global; bulk de mensajería probablemente necesita locks más finos (o una cola) si se quiere lanzar
  más de una campaña simultánea.
- **Throttle 429-aware real**: vive en `GestionRealClient.ts` (no en un archivo "gr-invoices-sync"
  separado — ese nombre es el de la carpeta openspec del feature que lo INTRODUJO). Backoff
  exponencial `base·3^i + jitter` (línea 118-121), respeta `Retry-After` de un 429 (`retryAfterMs`,
  líneas 217-225+), cap superior contra un `Retry-After` hostil, `RETRYABLE_STATUS = {429,500,502,503,504}`
  (línea 199) — **pero es REACTIVO**: reintenta después de fallar, no previene la ráfaga. **No hay
  ningún limitador PROACTIVO (token bucket / N req por segundo) en el repo** — el requisito de
  ~80msg/s por sender de Twilio necesita ese patrón nuevo (no hay de dónde clonarlo 1:1; el backoff
  de GR sirve como red de seguridad SECUNDARIA para cuando el proactivo falla igual).

**Conclusión área 5**: se reusa la FORMA del batch (entidad+port+runner con lock) casi 1:1; el
throttle reactivo (retry+backoff) se clona de `GestionRealClient`; el throttle PROACTIVO (rate
limiter ~80/s) es pieza nueva, no hay precedente.

### 6. Opt-out / compliance

- Grep de `optOut|opt_out|unsubscribe|consent|whatsappOptIn|contactable` en TODO `src/`: **0
  resultados en el dominio de mensajería/cliente** (el único hit real, `ReceiveChatwootWebhook.ts`,
  es un falso positivo del propio grep sobre comentarios de código de esta exploración, no un campo
  real).
- `Client` no tiene ningún campo de consentimiento/opt-out. **Gap total, compliance duro**: WhatsApp
  Business exige poder dar de baja a un destinatario del bulk. Hace falta: campo nuevo (p.ej.
  `Client.whatsappOptOutAt DateTime?` o tabla separada si se quiere versionar el motivo/canal), un
  mecanismo de baja (palabra clave tipo "BAJA"/"STOP" detectada en el webhook de inbound, o link/botón
  en el template), y que el segment builder lo excluya SIEMPRE (aunque el operador seleccione ese
  nodo/estado).

### 7. Matcher de teléfono

- `src/application/use-cases/recapture/matchActiveClient.ts:38-59` — `normalizePhone`: strip
  no-dígitos, drop código de país "54" (si len≥11), drop ceros líder, drop "9" móvil (si len≥11), drop
  "15" líder, piso de `PHONE_MIN_SIGNIFICANT_DIGITS=6`. `suffixMatch` (líneas 66-71): compara los
  últimos `min(8, len_a, len_b)` dígitos.
- Ya reusado VERBATIM por `GetClientContextByPhone.ts:3,20,24` para el inbox (F1). Mismo mecanismo
  sirve para: (a) de-dup de destinatarios del bulk (dos `Client.phone` que normalizan igual =
  mismo destinatario), (b) matchear la respuesta entrante del cliente contra el `Client` (ya lo hace
  el inbox), (c) matchear el teléfono del segmento contra `Conversation.contactPhone` para decidir
  "ya tiene conversación abierta" vs "hay que crear una".
- **Caveat documentado en el propio código** (línea 53, comentario): no distingue un "15" insertado
  entre código de área y número (gap conocido, no se re-litiga acá).

### 8. RBAC

- `messaging.read`/`messaging.send` — únicos permisos existentes, sembrados por
  `prisma/migrations/20260904000100_messaging_permissions/migration.sql` (patrón: `RbacModule`
  code='messaging' + `RbacPermission(moduleId, action)` + `RbacRolePermission` grants a
  `super_admin`/`administrador`, todo `ON CONFLICT DO NOTHING`, idempotente).
- `messaging.bulk`/`messaging.templates` **NO existen** — confirmado por grep (0 matches en
  migraciones ni en código de rutas). Estaban bocetados en el BACKLOG (línea 23-40) y el propio
  proposal de F1 los lista como **explícitamente fuera de alcance**
  (`archive/2026-07-12-messaging-inbox/proposal.md:56`: "Permisos `messaging.bulk`/`messaging.templates`").
- Patrón de enforcement en ruta: factory `createMessagingRouter(..., perms)` con `perms.read`/
  `perms.send` como `RequestHandler` inyectados por endpoint (`messaging.routes.ts` líneas 313, 342,
  357, 374, 399, 446, 467, 488, 511, 528, 545) — mismo molde para `perms.bulk`/`perms.templates`.

**Conclusión área 8**: falta UNA migración aditiva nueva (mismo molde exacto que
`20260904000100_messaging_permissions`) que siembre `bulk`/`templates` bajo el módulo `messaging`
existente + grants a los roles que correspondan.

---

## (c) Los 2 grandes incógnitos

### Incógnita 1 — Link Client → Nodo

| Camino | Feasibility | Cobertura | Tipo de dato | Caveats |
|---|---|---|---|---|
| **PPPoE → NAS** (`Client→Contract→PppoeService.nasId→NasServer`, `schema.prisma:1829-1857`) | Alta — FK real, cadena existe hoy | Solo clientes con contrato+servicio PPPoE activo (no cubre clientes sin `PppoeService`, p.ej. de baja o solo-fibra sin PPPoE) | **Directo** (FK), pero granularidad EQUIVOCADA: `NasServer` = BRAS/router (~4-5 en toda la red, según memoria de infra), NO "nodo/antena". Segmentar "por nodo" con esto en realidad segmenta "por BRAS", mucho más grueso de lo que pide el requisito |
| **UISP vía MAC** (`PppoeService.callerId` (MAC CPE) ↔ `UispDevice.mac` → `UispDevice.uispSiteId` ↔ `NetworkSite.uispSiteId` texto suelto, `schema.prisma:1744-1748`, `2542-2566`) | Media-baja — NINGÚN FK en schema conecta `Client`/`PppoeService` con `UispDevice`; hay que armar el JOIN en aplicación por igualdad de MAC | Depende de que el cliente esté conectado (callerId se llena "de la última sesión vista") Y de que la MAC coincida exactamente con el dispositivo en UISP (puede ser router del cliente, no el radio) | **Derivado/heurístico**, doble hop con matching por string, sin precedente de código que lo haga hoy (ni el runbook `uisp-recovery-ipnext` ni `diagnostico-cliente-ipnext` lo usan para bulk — son diagnóstico 1-a-1, no joins masivos) | Frágil: CPE puede ser un router detrás del radio (MAC distinta), o `callerId` nulo/stale |
| **Tareas de RED del cliente** (`ScheduledTask.networkSiteId` de tareas asociadas) | **Nula, tal como está planteada.** Verificado en `CreateTask.ts:24-83`: `kind='network'` (tiene `networkSiteId`) y modo customer (tiene `customerId`) son **mutuamente excluyentes** por diseño — ninguna fila de `ScheduledTask` tiene AMBOS campos seteados a la vez | 0% — no hay ninguna tarea que sea simultáneamente "del cliente X" y "del nodo Y" | N/A | El campo `NetworkSite.clientCount` (`schema.prisma:1733`) PARECE sugerir un conteo de clientes por sitio, pero se confirmó (grep de `clientCount` uso en `PrismaNetworkSiteRepository.ts`) que es un **campo editable a mano** (`data.clientCount ?? 0` en create, `!== undefined` en update) — NO se calcula de un join real contra `Client`. No hay atajo escondido acá |
| **Heurística geo (nueva, no explorada por el equipo aún)** | Media — `Contract.gpsLat/gpsLng` (o `lat/lng` de GR) vs `NetworkSite.lat/lng`: nearest-neighbor por distancia | Depende de que el contrato tenga coordenadas cargadas (GR o Prominense-owned) — cobertura variable, no medida en esta exploración | **Derivado/heurístico**, requiere un cálculo geoespacial nuevo (no hay ninguna función de distancia en el repo hoy) | No hay antecedente de código; introduce falsos positivos si dos nodos están cerca entre sí |

**Cuál tiene mejor cobertura vs cuál es dato directo**: PPPoE→NAS es el ÚNICO camino con FK real
(dato directo), pero resuelve la pregunta equivocada (BRAS, no antena). Los otros tres son 100%
heurísticos/derivados y ninguno tiene precedente de implementación en este repo — el "eje de nodo"
que pidió el usuario (BACKLOG línea 35, decisión (b)) es, a día de hoy, un **dato que no existe en
ningún lado con la granularidad pedida**. Cualquier v1 que segmente por nodo real necesita: (1)
escoger UNA heurística y aceptar su cobertura parcial, o (2) invertir en un spike dedicado para
construir el link (posible: agregar `Client.networkSiteId` directo, poblado por un proceso de
backfill con la mejor heurística disponible, y mantenido hacia adelante en el flujo de alta/instalación).

### Incógnita 2 — Templates de Meta/Twilio

| Opción | Feasibility | Qué falta | Riesgo |
|---|---|---|---|
| **(A) Templates vía Chatwoot** | Sin verificar — requiere spike contra `.37` | Confirmar si la Application API v1 (la que ya consume `HttpChatwootGateway`) expone algún endpoint de template/Content, y si la instancia tiene los templates de Meta ya cargados en Chatwoot | Si Chatwoot NO expone esto por API (solo por su UI), esta opción muere y hay que ir a (B) igual |
| **(B) Twilio Content API directo** | Media — es un adapter nuevo (`TwilioContentGateway` o similar), credenciales Twilio (SID/token/`ContentSid` por template), y hay que decidir cómo el mensaje saliente-vía-Twilio-directo se refleja en el mirror `ChatMessage`/en Chatwoot (para que el hilo se vea completo en el inbox F1) | Ninguno de los dos adapters existe; hay que definir el contrato de "aprobación de template" (mapeo `ContentSid`↔nombre interno del mensaje bulk, variables permitidas) | Doble fuente de verdad (Twilio directo + Chatwoot) si Chatwoot no se entera del envío — puede romper la "respuesta cae en el inbox gratis" que asume el contexto del change, si Chatwoot no tiene la conversación creada de antemano |

**Gap conciso**: hoy TODO pasa por Chatwoot (Application API v1); no hay ruta a la Content API de
Twilio en ningún adapter existente. Mandar un template fuera de ventana requiere, como mínimo, un
adapter nuevo — la pregunta abierta es si ese adapter habla con Twilio directo o si Chatwoot puede
hacerlo de intermediario (spike obligatorio antes del proposal).

---

## (d) Qué se REUSA vs qué FALTA crear

**Se reusa tal cual:**
- `Conversation`/`ChatMessage`/`ChatMessageAttachment` (mirror), `ConversationRepository`,
  `ChatMessageRepository`, `WebhookDeliveryRepository`.
- `ReceiveChatwootWebhook` (las respuestas al bulk entran igual que cualquier inbound).
- `normalizePhone`/`suffixMatch` (de-dup + matching, sin reimplementar).
- `SendMessage` como pieza PARCIAL (solo aplica al sub-caso "responder dentro de ventana 24h",
  no al primer envío del bulk).
- Molde de `ServiceCutBatch`/`ServiceCutBatchRepository`/`ServiceCutRunner` (entidad+port+runner con
  lock distribuido) como plantilla estructural para `Campaign`/`CampaignRecipient`.
- Backoff reactivo 429-aware de `GestionRealClient` (clonar la función, no el archivo).
- `ClientStatus` enum + `Client.balanceDue` + `CustomerRepository.stats()` para el segment builder.
- Patrón RBAC (`RbacModule`/`RbacPermission`/`RbacRolePermission`, migración idempotente) y el molde
  de ruta `perms.<action>` inyectado.

**Falta crear (nuevo, sin precedente):**
- Modelos `Campaign`/`CampaignRecipient` + migración (confirmado 0 matches en schema).
- Adapter/puente a templates de Meta (Twilio Content API directo, o extensión del `ChatwootGateway`
  si (A) resulta viable tras el spike) — **bloqueante de diseño**.
- `Client → NetworkSite` — ya sea un campo FK nuevo poblado por heurística/backfill, o resignarse a
  segmentar por una proxy más gruesa (NAS) en v1.
- Rate limiter PROACTIVO (~80msg/s, token bucket) — no hay precedente en el repo.
- Campo(s) de opt-out/consentimiento en `Client` (o tabla dedicada) + detección de baja por
  keyword en el webhook inbound.
- Extensión de `ListClientsQuery`/`CustomerRepository.list` para status multi-select + rango de
  `balanceDue`.
- Migración RBAC nueva sembrando `messaging.bulk`/`messaging.templates`.
- Caso de uso "ensure conversation by phone" (crear conversación si no existe — hoy `ChatwootGateway`
  no tiene `createConversation`, solo `searchContact`, nunca invocado).
- Historial de campañas (UI + endpoint de listado; el `ServiceCutBatch` da el molde de progreso pero
  no hay pantalla de "histórico" precedente para clonar 1:1 del lado de mensajería).

---

## (e) Opciones de CORTE para v1

1. **Slice por ESTADO, sin nodo** — segmentar solo por `ClientStatus`/`balanceDue` (área 3, ya casi
   lista) + templates resueltos. Entrega valor rápido (recordatorios de deuda a `late`, avisos a
   `blocked`/`baja`) sin tocar el incógnito 1. Tradeoff: no cumple el requisito "por NODO" del change;
   puede leerse como MVP incompleto si el usuario ya prometió segmentación geográfica.
2. **Completo con nodo (heurística aceptada)** — elegir PPPoE→NAS como proxy de nodo (única con FK
   real) y comunicar explícitamente que "nodo" en v1 = "BRAS/router", no antena. Tradeoff: cumple el
   requisito nominal pero con granularidad mucho más gruesa que lo que probablemente el usuario
   imagina al decir "nodo" (antena/sitio), y deja fuera a los clientes sin `PppoeService` activo.
3. **Spike de nodo aparte + slice por estado primero** — construir F2 en dos entregas: (i) release 1
   = estado/deuda (opción 1) ya en prod, feedback real; (ii) spike dedicado, en paralelo o después,
   para decidir/backfillear `Client.networkSiteId` con la mejor heurística (o aceptar el costo de
   pedir el dato a upstream/IClass), y recién ahí sumar el filtro por nodo real a la campaña.
   Tradeoff: más iterativo, más tiempo total, pero evita comprometerse a una heurística frágil (UISP
   por MAC) o a una granularidad equivocada (NAS) bajo presión de fecha.

---

## (f) Riesgos / dependencias externas

- **Meta/WhatsApp**: cualquier template usado en bulk debe estar PRE-aprobado por Meta antes de
  poder mandarse — el ciclo de aprobación de Meta es externo, no controlable desde este repo, y
  puede tardar días. Bloquea el "camino feliz" de F2 hasta tener al menos un template aprobado.
- **Twilio throughput**: ~80msg/s por sender es un límite de Twilio, no de este backend — el rate
  limiter proactivo debe respetarlo, y un burst mal calculado puede consumir cuota/dinero real.
  Verificar el límite EXACTO del plan de Twilio contratado (puede no ser 80/s en la práctica).
  Confirma cliente1: Twilio 429 es igual de posible en el bulk que en cualquier otra integración —
  el backoff reactivo de `GestionRealClient` es la red de seguridad, no la prevención.
- **Chatwoot v4.13.0 (`.37`)**: cualquier decisión sobre templates (Incógnita 2) depende de verificar
  contra la instancia REAL — mismo patrón de "best-effort sin verificar en vivo" que ya dejó pendiente
  F1 (`HttpChatwootGateway.ts:79-82`). No asumir capacidades sin spike.
- **Compliance**: sin opt-out, cualquier bulk expone a Prominense a reportes de spam/baneo del
  número de WhatsApp Business ante Meta — riesgo de negocio, no solo técnico.
- **Cobertura de nodo**: si se elige la opción 2 (PPPoE→NAS), los clientes sin `PppoeService` activo
  (de baja, o solo-fibra sin PPPoE registrado) quedan sistemáticamente fuera de cualquier segmento
  "por nodo" — puede ser una fracción no trivial de la base.

---

## (g) Preguntas abiertas para el proposal

1. ¿Se acepta la opción de corte 1 (estado/deuda sin nodo) como v1, o el nodo es un requisito duro
   desde el día 1 aunque implique granularidad de BRAS en vez de antena?
2. Si el nodo es duro: ¿vale la pena invertir en backfillear `Client.networkSiteId` con una
   heurística (UISP-por-MAC o geo-nearest), aceptando falsos negativos/positivos, o se prefiere pedir
   el dato "limpio" a upstream (IClass/GR) si en algún momento lo modelan?
3. Templates: ¿spike contra Chatwoot `.37` primero (opción A) antes de comprometerse a un adapter
   Twilio directo (opción B)? ¿Quién tiene las credenciales/acceso para probar la Content API de
   Twilio en un ambiente de prueba?
4. Opt-out: ¿un campo simple (`whatsappOptOutAt`) alcanza, o el compliance real exige historizar
   motivo/canal de baja (tabla dedicada, auditable)?
5. Concurrencia de campañas: ¿un lock global (un batch de campaña a la vez, como hoy en
   `ServiceCutRunner`) es aceptable, o el negocio necesita correr 2+ campañas en simultáneo (locks
   por-campaña o cola con prioridad)?
6. RBAC: ¿`messaging.bulk` y `messaging.templates` son 2 permisos separados (gestionar destinatarios
   vs gestionar/aprobar templates) o alcanza con uno solo (`messaging.bulk`) y templates se gestionan
   fuera del backend (directamente en Twilio/Meta Business Manager)?
7. Historial de campañas: ¿qué nivel de detalle necesita la pestaña (solo agregados tipo
   `ServiceCutBatch`, o detalle por destinatario con estado de entrega/lectura de Twilio, que
   requeriría un webhook de status de Twilio adicional al de Chatwoot)?

---

## Artefactos

- `openspec/changes/messaging-bulk/explore.md` (este archivo)
- Engram: `topic_key: "sdd/messaging-bulk/explore"`, `project: "ipnext-backend"`, `type: "architecture"`
