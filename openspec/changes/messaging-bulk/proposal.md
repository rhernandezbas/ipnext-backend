# Proposal — messaging-bulk (EPIC Mensajería omnicanal WhatsApp en Prominense, F2)

## 1. Why / Intent

F1/F1.5 (INBOX Chatwoot) ya están en prod: Prominense es **front sobre Chatwoot** (motor
Twilio/WhatsApp, VPS `.37`), con mirror local `Conversation`/`ChatMessage`, gateway
`MessagingGateway`/adapter Chatwoot, use cases `SendMessage`/`ReceiveChatwootWebhook` y RBAC
`messaging.read`/`messaging.send`. Pero HOY **no existe ningún envío saliente masivo**: cada aviso
a deudores/activos (recordatorio de deuda, aviso de corte, promo, bienvenida) se manda **a mano**,
uno por uno, sin registro de a quién se le mandó ni qué pasó con cada envío.

**Valor de F2**: poder segmentar la base por **estado de cliente** y disparar un **envío masivo por
template aprobado** — recordatorio de deuda a `late`, aviso de corte a `blocked`, reenganche a
`baja`, bienvenida a `active` — con **historial de campañas** (quién mandó qué, a cuántos, con qué
resultado por destinatario). Las **respuestas del cliente caen al inbox F1 "gratis"** (mismo webhook
de Chatwoot), cerrando el loop conversación → contexto → respuesta sin construir nada nuevo del lado
de entrada.

Este proposal es **BE-first**. El FE (composer de campaña + segment builder + tabla de historial) es
un cambio COORDINADO posterior, una vez lockeado el contrato del BE.

## 2. Scope IN (v1)

1. **Segmentación por ESTADO** — multi-status (`ClientStatus IN [active|late|blocked|inactive|baja]`,
   hoy el filtro es un solo string) + rango/umbral de `Client.balanceDue`. Extensión aditiva de
   `ListClientsQuery`/`CustomerRepository.list` (`domain/ports/CustomerRepository.ts:4-7`).
2. **Envío por template aprobado de Meta** — es el **core del bulk, no un extra**: todo envío a
   deudores/inactivos cae SIEMPRE fuera de la ventana 24h de WhatsApp Business → EXIGE template
   aprobado. El usuario ya tiene templates aprobados en Meta (Twilio Content aún sin configurar — ver
   §4 send-path).
3. **Batch async resumible con rate-limit proactivo** — worker estilo `ServiceCutRunner` (lock
   distribuido, `start()` rápido + `run()` fire-and-forget poleable), throttle proactivo (~80 msg/s,
   token bucket) + backoff reactivo 429-aware como red de seguridad.
4. **Opt-out por cliente (compliance)** — campo nuevo en `Client` + enforcement SIEMPRE en la
   resolución de destinatarios (aunque el operador seleccione ese segmento). Ver §5.
5. **Historial de campañas** — persistencia de la campaña (header con contadores) + status
   **por-destinatario** (queued/sent/delivered/failed/opted-out/skipped), poleable durante el envío y
   auditable después.
6. **RBAC** — permisos nuevos `messaging.bulk` + `messaging.templates` bajo el módulo `messaging`
   existente. Ver §.RBAC.

## 3. Scope OUT (explícito — anti scope-creep)

- **Segmentación por NODO** → **v2**. LOCKED: el `Client` no tiene fuente de datos limpia de nodo
  (PPPoE→NAS da granularidad de BRAS equivocada, `ScheduledTask.networkSiteId` = 0% cobertura,
  `NetworkSite.clientCount` es campo editado a mano). v2 requiere modelar un `Client.networkSiteId`
  real + backfill como esfuerzo PROPIO. No se toca en v1.
- **Delivery receipts vía Twilio status callback** (sent→delivered→read reales) → **F3**. En v1 el
  status por-destinatario refleja el resultado del ENVÍO (aceptado/fallado por la API), no la entrega
  confirmada por Twilio.
- **UI avanzada de gestión de templates** (crear/editar/aprobar desde Prominense) → los templates se
  gestionan en Meta Business Manager / Twilio; v1 solo los LISTA y los usa.
- **Programación de envíos** (schedule a futuro, recurrencia) → fuera de v1; v1 dispara on-demand.

## 4. Approach / Arquitectura (hexagonal)

### 4.1 Modelos nuevos (migración aditiva)

**`Campaign`** (header + contadores, molde `ServiceCutBatch` `domain/entities/serviceCutBatch.ts:20-30`):

| Campo | Tipo | Nota |
|---|---|---|
| `id` | String @id | cuid |
| `name` | String | nombre humano de la campaña |
| `templateRef` | String | ref del template a enviar (Chatwoot template id **o** `ContentSid` Twilio, según send-path) |
| `templateName` | String? | nombre interno legible del template |
| `segment` | Json | filtro serializado: `{ statuses: [...], balanceMin?, balanceMax? }` (reproducible/auditable) |
| `status` | enum | `pending \| running \| paused \| done \| failed` |
| `total` | Int | destinatarios resueltos al crear |
| `sentCount` / `failedCount` / `skippedCount` / `optedOutCount` | Int | contadores agregados |
| `createdById` | String | quién la disparó (FK user) |
| `createdAt` / `startedAt` / `finishedAt` | DateTime(?) | timeline |
| `error` | String? | error fatal del batch (si `failed`) |

**`CampaignRecipient`** (status por-destinatario, molde `ServiceCutItemResult` pero PERSISTIDO por fila):

| Campo | Tipo | Nota |
|---|---|---|
| `id` | String @id | |
| `campaignId` | String FK → Campaign | |
| `clientId` | String FK → Client | |
| `phoneNormalized` | String | de `normalizePhone`, clave de de-dup |
| `status` | enum | `queued \| sent \| delivered \| failed \| opted-out \| skipped` |
| `chatwootConversationId` | String? | link al mirror F1 cuando el envío crea/usa conversación |
| `sentAt` / `deliveredAt` | DateTime? | (`deliveredAt` recién se llena en F3) |
| `error` | String? | motivo del fallo por-destinatario (best-effort, no aborta el lote) |

Índices: `@@unique([campaignId, clientId])` + `@@index([campaignId, status])` (progreso poleable).

Migraciones: **una aditiva** (modelos + enums) generada con `prisma migrate diff --from-schema
--to-schema --script` + **una RBAC** (siembra de permisos, ver §RBAC). Van al deploy — no hay DB local.

### 4.2 Ports

- **`CampaignRepository`** (`domain/ports/`) — `create`, `findById`, `update` (patch parcial snapshot,
  last-write-wins), `list`, más los métodos de recipients (`bulkCreateRecipients`,
  `updateRecipient`, `listRecipients(campaignId, status?)`). Molde directo de
  `ServiceCutBatchRepository` (`domain/ports/ServiceCutBatchRepository.ts`).
- **`TemplateMessagingPort`** (port NUEVO, **recomendado** por sobre extender `MessagingGateway`).
  Métodos: `listTemplates()`, `sendTemplate(phone, templateRef, variables, opts?)`.
  **Por qué un port nuevo y NO extender `MessagingGateway`/`ChatwootGateway`**:
  1. **ISP (Interface Segregation)** — `MessagingGateway` (F1) modela ops a nivel CONVERSACIÓN ya
     existente (`sendMessage` requiere `chatwootConversationId` previo, `HttpChatwootGateway.ts:164-202`).
     Los templates + primer-contacto-outbound son una responsabilidad DISTINTA (crear/enganchar la
     conversación desde cero, fuera de ventana). Mezclarlas ensucia el contrato estable de F1.
  2. **Aísla la incógnita del send-path** — el adapter del port nuevo es el ÚNICO punto que decide
     A (Chatwoot-templates) vs B (Twilio directo). Si el spike valida A → el adapter envuelve
     Chatwoot; si obliga a B → envuelve Twilio Content. **Los use cases dependen SOLO del port** y no
     se enteran de cuál ganó. Es la jugada hexagonal limpia: la decisión no verificada queda encapsulada
     en un adapter reemplazable, sin filtrarse al núcleo.

### 4.3 Use cases (verbo+sustantivo, 1 por archivo)

- **`ListTemplates`** — lista los templates disponibles (delega en `TemplateMessagingPort.listTemplates`).
- **`PreviewCampaignSegment`** (a.k.a. `CountRecipients`) — resuelve el segmento a destinatarios
  concretos: aplica el filtro (status multi + balanceDue), **excluye opt-out SIEMPRE**, **de-dup por
  `normalizePhone`** (dos `Client.phone` que normalizan igual = 1 destinatario). Devuelve conteo +
  preview sin persistir. Reusa `normalizePhone`/`suffixMatch` VERBATIM.
- **`CreateCampaign`** — persiste `Campaign` (pending) + genera `CampaignRecipient[]` (queued) a partir
  del preview. Serializa el `segment` para auditoría.
- **`SendCampaign`** — worker async, molde `ServiceCutRunner` (`infrastructure/scheduling/ServiceCutRunner.ts:24-74`):
  `DistributedLock.tryAcquire`, `start()` rápido devuelve `campaignId`, `run()` fire-and-forget recorre
  recipients aplicando **rate-limit proactivo** + backoff 429. **Resumible**: al reanudar salta los
  recipients ya `sent` (idempotencia por status por-fila). Por cada destinatario: ensure-conversation →
  sendTemplate → update status.
- **`GetCampaign`** — header + contadores + (opcional) recipients paginados. Poleable.
- **`ListCampaigns`** — historial de campañas (para la tabla del FE).
- **`EnsureConversationByPhone`** (soporte de outbound) — hoy `ChatwootGateway` NO tiene
  `createConversation` (solo `searchContact`, nunca invocado, `ChatwootGateway.ts:110`). El bulk manda
  el PRIMER mensaje sin conversación previa → necesita ubicar o crear la conversación por teléfono para
  que el hilo aparezca en el inbox F1 y la respuesta caiga "gratis". El alcance exacto de este caso
  (¿Chatwoot lo crea solo al recibir el outbound?, ¿hay que crearlo explícito?) depende del spike §4.5.

### 4.4 Reuso explícito (qué se clona, de dónde)

- **Molde de batch** `ServiceCutBatch`/`ServiceCutBatchRepository`/`ServiceCutRunner` (entidad + port +
  runner con lock distribuido) → `Campaign`/`CampaignRecipient`/`CampaignRepository`/worker.
- **Backoff reactivo 429-aware** de `GestionRealClient.ts` (exponencial `base·3^i + jitter`, respeta
  `Retry-After`, `RETRYABLE_STATUS={429,500,502,503,504}`) → **clonar la función**, red de seguridad
  del rate-limiter.
- **`normalizePhone`/`suffixMatch`** (`recapture/matchActiveClient.ts:38-71`) → de-dup de destinatarios +
  matching de respuestas. VERBATIM, sin reimplementar.
- **Mirror `Conversation`/`ChatMessage`** + `ReceiveChatwootWebhook` → las respuestas al bulk entran por
  el MISMO camino que cualquier inbound. + `EnsureConversationByPhone` para el outbound.
- **`ClientStatus` enum + `Client.balanceDue` + `CustomerRepository.stats()`** → segment builder
  (mostrar cuántos hay por segmento antes de disparar).
- **Patrón RBAC** de la migración de F1 (`20260904000100_messaging_permissions`,
  `RbacModule`+`RbacPermission`+`RbacRolePermission` idempotente `ON CONFLICT DO NOTHING`) + molde de
  ruta `perms.<action>` inyectado por endpoint.

### 4.5 Send-path — DECISIÓN: A (recomendado) con spike, B (fallback)

**Camino A (RECOMENDADO) = mandar los templates VÍA Chatwoot.** Reusa el motor de F1 y es consistente
con el principio "Prominense = front sobre Chatwoot, NO reimplementa mensajería". El `TemplateMessagingPort`
lo implementaría un adapter que habla con la API de Chatwoot para listar/enviar templates.

**Validación = SPIKE EN VIVO contra el Chatwoot del `.37`, como PRIMERA tarea del design (design task #1).**
Preguntas que el spike DEBE responder antes de comprometer el adapter:
1. ¿La API de Chatwoot (la que ya consume `HttpChatwootGateway`, o alguna otra de la misma instancia)
   expone un endpoint para **enviar un template aprobado fuera de la ventana 24h**?
2. ¿La instancia `.37` tiene los templates de Meta **sincronizados desde el provider** (Twilio) y
   listables por API?

**Camino B (FALLBACK) = adapter Twilio Content directo** — SOLO si el spike descarta A. Implica:
configurar Twilio Content, importar los templates aprobados → obtener `ContentSid` por template, y un
adapter nuevo (`TwilioContentGateway`) que implementa el MISMO `TemplateMessagingPort`. Costo extra:
reconciliar el saliente-vía-Twilio-directo con el mirror `ChatMessage`/Chatwoot para que el hilo se vea
completo en el inbox F1 (Chatwoot tiene que enterarse del envío, sea por su propio webhook de outgoing o
por un upsert manual desde Prominense).

**El port nuevo `TemplateMessagingPort` hace que A→B sea un swap de adapter, no un rediseño.** Este es el
argumento central de §4.2.

## 5. Opt-out / compliance

**Gap total hoy**: `Client` no tiene NINGÚN campo de consentimiento (grep 0 matches). WhatsApp Business
EXIGE poder dar de baja a un destinatario, o Meta banea el número.

- **Campo nuevo recomendado: `Client.whatsappOptOutAt DateTime?`** (null = contactable). Elijo el
  timestamp sobre un `Boolean` pelado porque a costo ~0 me da el flag Y el "cuándo" (auditable para
  compliance), estrictamente superior. `whatsappOptOutAt IS NOT NULL` = excluido.
- **Enforcement**: `PreviewCampaignSegment`/`SendCampaign` excluyen SIEMPRE los opt-out, aunque el
  operador seleccione ese estado. No es opcional, no es un checkbox del operador.
- **Detección de baja**: keyword tipo "BAJA"/"STOP" en el webhook inbound (`ReceiveChatwootWebhook`)
  setea `whatsappOptOutAt`. El alcance exacto (keyword vs link/botón en el template) → spec/design.
- **Riesgo de negocio**: sin opt-out, un bulk mal mandado expone a Prominense a reportes de spam →
  baneo del número de WhatsApp Business ante Meta. Riesgo real, no solo técnico.

## RBAC

Migración aditiva nueva, MISMO molde que `20260904000100_messaging_permissions`: siembra bajo el módulo
`messaging` existente los permisos **`messaging.bulk`** (crear/preview/disparar campañas + ver historial)
y **`messaging.templates`** (listar/usar templates), con grants idempotentes a `super_admin`/`administrador`.
Rutas nuevas gatean con `perms.bulk`/`perms.templates` inyectados por endpoint (molde `messaging.routes.ts`).
Si `templates` se termina gestionando 100% fuera del BE, `messaging.templates` podría colapsarse en
`messaging.bulk` (ver open questions).

## 6. Fases del change

- **v1 (ESTE change)** — segmentación por estado + envío por template + batch resumible + opt-out +
  historial + RBAC. **Dentro de v1**: el **spike de send-path es design task #1** — se corre ANTES de
  comprometer el adapter concreto del `TemplateMessagingPort`.
- **v2** — segmentación por **NODO**: modelar `Client.networkSiteId` real + backfill + mantenerlo en el
  flujo de alta. Esfuerzo propio, fuera de v1.
- **F3** — delivery receipts reales (Twilio status callback: sent→delivered→read) + métricas de campaña.

## 7. Riesgos / dependencias externas

1. **Templates Meta** — ya aprobados = OK para el camino feliz, PERO cada envío **cuesta dinero**
   (pricing de conversación de Meta/Twilio). Un bulk grande tiene costo real → tope de segmento (open q).
2. **Throughput Twilio** — el ~80 msg/s es límite de Twilio, no del backend. **Verificar el límite EXACTO
   del plan contratado** (puede no ser 80/s en la práctica). El rate-limiter proactivo debe respetarlo;
   el backoff reactivo es la red de seguridad, no la prevención.
3. **Capacidad de template de Chatwoot `.37` SIN verificar** — mismo patrón de duda que F1 (best-effort
   sin verificar en vivo, `HttpChatwootGateway.ts:79-82`). **Bloqueante de diseño → spike live (§4.5)**.
   Si A muere, B (Twilio directo) es más trabajo (adapter + reconciliación con el mirror).
4. **Compliance sin opt-out** — riesgo de baneo del número WhatsApp Business. Mitigado por §5, pero la
   detección de baja depende de definir bien el keyword/mecanismo.
5. **Concurrencia de campañas** — el molde `ServiceCutRunner` asume **un batch a la vez GLOBAL** (lock
   único). Si el negocio necesita 2+ campañas simultáneas, hay que refinar a locks por-campaña o cola
   (open question).

## 8. Preguntas abiertas para specs/design

1. **Historial** — ¿granularidad agregada (solo contadores tipo `ServiceCutBatch`) o detalle por-destinatario
   navegable en la UI? (afecta endpoints de `GetCampaign`/`ListCampaigns` y paginación de recipients).
2. **Concurrencia** — ¿lock GLOBAL (una campaña a la vez, como hoy) o por-campaña / cola? (riesgo #5).
3. **Variables de template** — ¿qué variables soporta v1? (`{{nombre}}`, `{{monto_deuda}}`, …) y de dónde
   se resuelven (`Client.name`, `Client.balanceDue`). Define el shape de `sendTemplate(variables)`.
4. **Tope de tamaño de segmento** — ¿hay un máximo de destinatarios por campaña (costo/seguridad)?
5. **Política de reintentos por-destinatario** — un `failed` por-fila: ¿se reintenta automático en el mismo
   batch, en un re-run manual, o queda muerto? (interactúa con la idempotencia por status).
6. **Opt-out profundidad** — ¿`whatsappOptOutAt DateTime?` alcanza, o compliance exige historizar
   motivo/canal en tabla dedicada auditable?
7. **RBAC granularidad** — ¿`messaging.bulk` + `messaging.templates` separados, o uno solo si templates se
   gestionan fuera del BE?

## Capabilities (para sdd-spec)

Un delta `specs/messaging-bulk/spec.md` con capabilities:
- **segmentación por estado** (multi-status + rango balanceDue, preview + de-dup + exclusión opt-out)
- **envío por template** (`TemplateMessagingPort`, send-path A/B tras spike)
- **campaña async resumible** (`Campaign`/`CampaignRecipient`, lock, rate-limit proactivo + backoff 429)
- **historial de campañas** (list/get + status por-destinatario)
- **opt-out / compliance** (`Client.whatsappOptOutAt` + enforcement + detección de baja)
- **RBAC messaging bulk** (`bulk`/`templates`)

## Artefactos

- `openspec/changes/messaging-bulk/proposal.md` (este archivo)
- `openspec/changes/messaging-bulk/explore.md` (insumo)
- Engram: `topic_key: "sdd/messaging-bulk/proposal"`, `project: "ipnext-backend"`, `type: "decision"`
