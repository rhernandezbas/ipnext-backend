# Exploration: messaging-inbox (F1 del EPIC "Mensajeria omnicanal WhatsApp en Prominense")

**Change**: messaging-inbox
**Project**: ipnext-backend
**Phase**: explore
**Date**: 2026-07-12
**Status**: complete — listo para proposal, con decisiones abiertas a cerrar antes de especificar

---

## Contexto / Objetivo de F1

Prominense pasa a ser un **FRONT sobre Chatwoot** (motor ya en prod, WhatsApp via Twilio, VPS `.37`,
container `chaboot_chatwoot`, dominio `chat.prometheus-alpha.xyz`). F1 = **INBOX**:

- Recibir WhatsApp entrantes en un apartado "Mensajes": lista de conversaciones + thread + historial.
- Panel de contexto del cliente: si el teléfono matchea un `Client` existente, mostrar datos/deuda/contratos.
- Responder dentro de la ventana de 24h de WhatsApp Business (fuera de ventana, Meta exige templates —
  eso es F2/F3, no F1, pero condiciona el wire contract de "puedo responder ahora?").

Decisiones YA tomadas por el usuario (BACKLOG.md líneas 13-22, sesión 2026-07-12, AskUserQuestion) y que
esta exploración NO relitiga: motor=Chatwoot, eje de nodo=sitio de red/antena (para F2), arranque=F1
primero. El BACKLOG ya trae un boceto de arquitectura BE (port `MessagingGateway`, endpoint
`POST /api/messaging/webhook`, use cases `ListConversations/GetConversation/ListMessages/SendMessage/
ReceiveChatwootWebhook/GetClientContextByPhone`, RBAC `messaging.read/send/bulk/templates`) — esta
exploración lo contrasta contra el código real, punto por punto.

---

## Hallazgos por punto

### 1. Webhooks entrantes — patrón HOY en Prominense

**No existe ningún endpoint que reciba un push externo con verificación de firma/HMAC.** Todo lo que
"parece" un webhook en este repo es, en realidad, uno de estos dos casos, ninguno aplicable directo:

- **Webhooks SALIENTES (admin-configurados)**: `src/domain/ports/SettingsRepository.ts:20-25`
  (`getWebhooks/createWebhook/updateWebhook/deleteWebhook/testWebhook`) + use cases
  `src/application/use-cases/{CreateWebhook,ListWebhooks,DeleteWebhook,TestWebhook}.ts`. Esto es
  Prominense **enviando** webhooks hacia afuera (Settings → Webhooks), no recibiendo. Irrelevante para
  F1 salvo como inspiración de shape de entidad (`Webhook` en `settings.ts`).
- **Ingest PULL, no PUSH**: `src/infrastructure/http/routes/gestionRealIngest.routes.ts:23-72`
  (`createGestionRealIngestRouter`) son rutas ADMIN para configurar/monitorear un scheduler que
  **Prominense** llama a GR cada N ms (`GestionRealSyncScheduler`), no al revés. Mismo patrón en IClass
  (`IngestClosedServiceOrders` — polling, no callback).
- **Lo más cercano a auth máquina-a-máquina INBOUND**: `src/infrastructure/http/middleware/
  apiKeyMiddleware.ts:13-42` (`createApiKeyMiddleware()`), usado en `/api/external/v1`
  (`app.ts:2498`). Compara una key estática (`config.externalApi.apiKey`,
  `src/infrastructure/config.ts:302-304`, env `EXTERNAL_API_KEY` en `env.example:117-120`) leída de
  `X-API-Key` o `Authorization: Bearer` contra un valor fijo con `!==` (no timing-safe, no HMAC de body).

**Conclusión**: Prominense **no tiene precedente de verificar la autenticidad de un webhook push real**.
El endpoint `POST /api/messaging/webhook` de F1 sería el PRIMERO de su clase en este backend. La API de
Chatwoot dada en contexto (`POST .../webhooks` para registrar) solo toma una URL — no hay evidencia (en
lo investigado) de un campo de secreto/firma HMAC configurable desde Chatwoot. Esto es una **decisión
abierta de seguridad**, no asumible: hay que verificar contra la instancia Chatwoot REAL corriendo en
`.37` qué soporta (¿header de firma? ¿nada?), y en el peor caso reusar el patrón `apiKeyMiddleware`
(shared secret embebido en la URL o header) + posible allowlist de IP origen (Chatwoot es self-hosted,
la IP de salida es conocida).

### 2. Matcher teléfono → cliente (`recapture-active-client-match`, #80)

Totalmente reusable, es código puro sin dependencias de framework:

- `normalizePhone()` — `src/application/use-cases/recapture/matchActiveClient.ts:38-59`. Normaliza
  código de país (`54`), ceros de troncal, marcador móvil `9`, prefijo `15`; garbage guard de 6 dígitos
  mínimos.
- `suffixMatch()` — `matchActiveClient.ts:66-71`. Compara los últimos 8 dígitos (`PHONE_SUFFIX_LENGTH`).
- `matchActiveClient()` — `matchActiveClient.ts:125-187`. Orquesta phone/email/reactivated/churn_reason
  signals contra un batch de contactos.
- Fuente de datos: `CustomerRepository.listActiveContacts()` — puerto en
  `src/domain/ports/CustomerRepository.ts:79` (shape `ActiveClientContact` en `:49-54`: solo
  `id/name/phone/email`). Implementación Prisma: `src/infrastructure/adapters/prisma/
  PrismaCustomerRepository.ts:296-311` — `select` angosto (4 columnas) `WHERE status='active'`, pero
  trae **TODOS** los clientes activos en una sola llamada (no hay índice de sufijo de teléfono en DB).
- Callers actuales: `GetRecaptureLead.ts:33,59` y `ListRecaptureLeads.ts:96,115` — ambos hacen el fetch
  completo UNA vez por request (página de leads o detalle de un lead), no por evento.

**Veredicto de reuso**: Sí, directo, para un nuevo use case `GetClientContextByPhone` (el nombre que ya
sugiere el BACKLOG). Ojo con el patrón de invocación: reusar `listActiveContacts()` tal cual significa
traer TODOS los clientes activos a memoria cada vez que se abre una conversación (para matchear el
teléfono del contacto de esa conversación). Para abrir UN panel de contexto está bien (un scan de
milisegundos). Sería un problema solo si la LISTA de conversaciones quisiera un badge "es cliente" por
cada fila sin memoizar el fetch una vez por request — a vigilar en el design, no bloqueante para F1.

### 3. Adapter HTTP externo — patrones de referencia para el `MessagingGateway`/Chatwoot client

Tres adapters existentes, cada uno un template válido con trade-offs distintos:

- **`HttpRadiusOrchestratorGateway`** (`src/infrastructure/adapters/orchestrator/
  HttpRadiusOrchestratorGateway.ts:32-179`) — el más simple y el que MÁS se parece a lo que necesitamos:
  bearer token estático horneado en el `AxiosInstance` al construirse (`:36-45`), un único wrapper
  `call()` que distingue 4xx-rechazado (`OrchestratorRejectedError`) de 5xx/red (
  `OrchestratorUnreachableError`) en `:51-63`. El `api_access_token` de Chatwoot (header
  `api_access_token`) calza igual de simple.
- **`GestionRealClient`** (`src/infrastructure/adapters/gestion-real/GestionRealClient.ts:56-192`) —
  agrega retry+backoff exponencial+jitter (`postWithRetry` en `:101-110`, `backoffMs` en `:118-124`)
  para un upstream flapeante. Probablemente overkill para F1 (Chatwoot corre en NUESTRO VPS, no es un
  3ro con LB inestable como GR) pero el patrón está ahí si se necesita.
- **`GigaredClient`** (`src/infrastructure/adapters/gigared/GigaredClient.ts:184-289`) — config
  **DB-backed**, releída en CADA llamada vía `configProvider.get()` (`:201-205`), + feature flag +
  middleware "ready" que devuelve 503 hasta que esté configurado Y flageado ON
  (`src/infrastructure/http/routes/gigared.routes.ts:56-82`). También el mejor ejemplo de RBAC granular
  por acción cableado 1:1 en `app.ts:2196-2215` (`requirePerm('tv', 'link'|'register'|...)`).

**Recomendación**: seguir la forma de `HttpRadiusOrchestratorGateway` (token estático, config simple, sin
DB-config) salvo que el equipo quiera poder rotar el `api_access_token`/account_id desde una UI de admin
sin redeploy — en cuyo caso el patrón `GigaredClient` (config en DB + flag) es el candidato. Decisión
abierta para el proposal.

### 4. Dónde viven las credenciales

`src/infrastructure/config.ts` — TODAS las integraciones externas son **opt-in**, ninguna en
`REQUIRED_VARS` (`config.ts:6-12`), o sea que si falta `CHATWOOT_*` el boot NO debe fallar (mismo patrón
que iclass `:93-98`, uisp `:140-143`, orchestrator `:186-190`). `env.example` documenta cada bloque con
comentarios inline (ver `iclass` en `env.example:43-49` como el análogo más cercano).

**Hallazgo colateral**: `env.example` está **desactualizado** — le faltan `UISP_BASE_URL`/`UISP_TOKEN`,
`ORCHESTRATOR_BASE_URL`/`ORCHESTRATOR_API_TOKEN` y `MINIO_*`, que SÍ existen en `config.ts:140-190,324-
336`. No es bloqueante para F1, pero al agregar `CHATWOOT_*` conviene no repetir el drift.

### 5. Estructura de un módulo nuevo — wiring de router + DI en `app.ts`

Dos ejemplos recientes, de complejidad creciente:

- **Simple (read/manage nomás)**: `actions-worklist`. Router factory
  `createActionsRouter(...)` (`src/infrastructure/http/routes/actions.routes.ts:72-157`) recibe los use
  cases + `auth: RequestHandler` + `perms: { read, manage }` (`:14-17`). Mount en
  `app.ts:2428` dentro de un bloque `{ }` que construye los repos/use cases justo arriba
  (`app.ts:2420-2456`).
- **Rico (config + flag + acciones granulares)**: `gigared`. `GigaredRouterDeps`
  (`gigared.routes.ts:175-218`) trae un `RequestHandler` por acción granular; mount en
  `app.ts:2176-2215` bajo `createAuthMiddleware(authAdapter, sessionRepo)`.
- **RBAC wiring**: factory de conveniencia `requirePerm` en `app.ts:811-812`:
  `(m: RbacModuleCode, a: PermissionAction) => requirePermission(rbacUserRepo, m, a)`. Cada mount arma
  `perms.read = requirePerm('modulo', 'read')`, etc.
- Agregar un módulo al catálogo RBAC son DOS ediciones a `src/domain/entities/rbac.ts`: agregar el
  código a `RBAC_MODULES` (`:92-136`, p.ej. `'actions'` en `:134-135`) y, si hacen falta acciones nuevas
  además de `read/manage`, agregarlas a `KNOWN_ACTIONS` (`:19-82`) — MÁS una migración de seed
  (`prisma/migrations/20260903000000_actions_permissions/migration.sql`, íntegramente leída: INSERTs
  idempotentes `ON CONFLICT DO NOTHING` que crean el módulo, sus permisos, y los otorgan a
  `super_admin` + `administrador`).

**Hallazgo colateral importante**: `app.ts` **ya NO tiene 617 líneas** (el número que cita
`openspec/config.yaml:37` y el propio `CLAUDE.md`) — tiene **2509 líneas** (`wc -l` verificado hoy). El
riesgo "God Object" que `config.yaml` pide flaguear está peor de lo documentado; agregar el wiring de
`messaging` lo va a empeorar un poco más (como cualquier módulo nuevo), consistente con la práctica
actual pero vale la pena decirlo en el proposal.

### 6. Persistencia — mirror local vs proxy live (LA decisión grande de F1)

Patrón mirror EXISTENTE (siempre PULL, nunca PUSH):

- `SyncGestionRealClients.ts:41-131` — pega a GR periódicamente y hace upsert en
  `ClientMirrorRepository` (`:63,129`), gateado por `FeatureFlagRepository` CHEQUEADO POR CORRIDA
  (`:75-79`, "para poder flipearlo por /feature-flags sin redeploy") + cursor en `SyncStateRepository`.
  Mismo patrón para `SyncUispMirror.ts` (sitios UISP) y para `PppoeService` ("inventario espejo" de
  RADIUS/NAS, por comentario del propio usuario en engram).

**La diferencia clave**: esos mirrors son PULL (Prominense encuesta la fuente cada N minutos); Chatwoot
sería PUSH (webhook). Un mirror push necesita la MISMA forma (tablas `Conversation`/`Message` en Prisma,
upsert al recibir el webhook) pero un cuento de resiliencia DISTINTO: un webhook perdido/caído = un
agujero PERMANENTE en el mirror, salvo que haya también un poll de reconciliación
(`GET .../conversations` de catch-up) — el patrón `SyncStateRepository`/cursor ya existe y es reusable
para ese backstop si se decide tenerlo.

| Approach | Pros | Contras |
|---|---|---|
| **Mirror** (tablas `Conversation`/`Message` propias, upsert on webhook) | Lecturas rápidas, tolera caídas de Chatwoot para HISTORIAL, fácil JOIN con `Client` (panel de contexto + segmentación F2 por nodo/estado), consistente con el precedente GR/UISP/PPPoE de este repo | Necesita backstop de reconciliación para webhooks perdidos; otro cursor de sync que mantener; riesgo de drift vs el estado real de Chatwoot |
| **Proxy live** (sin tablas locales, `MessagingGateway` lee Chatwoot en cada request) | Cero drift, menos piezas móviles para un F1 mínimo, el webhook solo dispara un "hay mensaje nuevo" para el realtime de la UI | Cada vista de lista/thread = llamada upstream en vivo (latencia + una caída del VPS Chatwoot tumba TODO el inbox de Prominense, no solo lo nuevo); más difícil de filtrar/joinear con `Client` server-side; sin historial local si Chatwoot alguna vez purga datos |

**Mi recomendación** (a validar en el proposal): **MIRROR**. Es el patrón que usa TODO el resto de este
codebase para integraciones externas (GR, UISP, IClass, PPPoE) y el boceto del propio BACKLOG
(`ReceiveChatwootWebhook` como use case implica escribir algo al recibir, no solo proxying). Pero hay que
decidir explícitamente el alcance del backstop de reconciliación en F1 (¿lo hay desde el día 1, o se
acepta el riesgo de gaps y se agrega después si se observan mensajes perdidos?).

### 7. RBAC granular — doble capa BE+FE

- **Catálogo BE, fuente única**: `src/domain/entities/rbac.ts` — `RBAC_MODULES` (`:92-136`) +
  `KNOWN_ACTIONS` (`:19-82`). Agregar `messaging` = append `'messaging'` a `RBAC_MODULES`. El boceto del
  BACKLOG (`messaging.read/send/bulk/templates`) necesita 3 acciones nuevas (`send`, `bulk`,
  `templates`) — precedente de módulos granulares que EVITAN el genérico `write` a favor de acciones
  nombradas (ver `tv`: `link/register/packs/ott/cancel/transfer`, sin `write`).
- **Seed**: nueva migración clonando el patrón idempotente de
  `prisma/migrations/20260903000000_actions_permissions/migration.sql` — módulo + N permisos + grants a
  `super_admin`+`administrador` (probablemente NO a `tecnico`/`noc` por defecto, seguiendo precedente).
- **Espejo FE**: NO verificable desde este repo (backend-only; `ipnext-frontend` es un repo separado).
  Los comentarios del código (`rbac.ts:161-167`, "mirrored on the FE") sugieren que el FE mantiene sus
  PROPIOS checks de permiso en paralelo (p.ej. un hook `useHasPermission('messaging','read')`) que se
  actualizan a mano junto con el catálogo BE — no hay una fuente generada compartida entre repos. Hay que
  verificar el mecanismo exacto del lado FE durante esa fase de diseño (fuera del alcance de este explore
  backend-only).

### 8. Link `Client` → `NetworkSite`/UISP (para F2, solo anotado — NO es alcance de F1)

- `Client` (`prisma/schema.prisma:170-`) no tiene NINGÚN FK de sitio de red/NAS.
- `NetworkSite` (`src/domain/entities/networkSite.ts:1-29`) no tiene `clientId`; es un catálogo de sitios
  físicos (pop/nodo/datacenter/tower) con contadores simples (`deviceCount`/`clientCount`), más un link
  opcional `uispSiteId` (`:28`) al mirror UISP y `iclassNodeCode` (`:26`) para dispatch a IClass.
- El único `networkSiteId` en el schema vive del lado de TAREA
  (`prisma/schema.prisma:1338-1339`, `ScheduledTask.networkSiteId` de `network-node-task`, y otra
  ocurrencia en `:1972`) — NO en `Client` ni en `Contract`.
- `Contract` (`prisma/schema.prisma:229-`) tampoco tiene `networkSiteId`; sí tiene `lat/lng/gpsLat/
  gpsLng` (coordenadas de instalación) — probablemente el hook geográfico más confiable si nunca se
  agrega un FK directo (heurística de "sitio más cercano").
- `NasServer` (`prisma/schema.prisma:1756-1773`) tampoco tiene `networkSiteId`.

**Conclusión para F2** (confirma lo que ya decía el BACKLOG): no existe HOY un edge limpio
`Client`→`NetworkSite`. Candidatos: (a) `PppoeService.nasId`→`NasServer`→(nada, NAS tampoco tiene sitio,
callejón sin salida tal cual), (b) heurística de sitio más cercano por `Contract.lat/lng`, (c) historial
de `ScheduledTask.networkSiteId` si el cliente tuvo alguna tarea de red asignada a un sitio. Ninguno es un
FK 1:1 limpio — F2 va a necesitar un link explícito nuevo, deliberadamente fuera de F1.

---

## Riesgo — colisión de nombres (hallazgo que CONTRADICE una asunción implícita del BACKLOG)

Ya existen, sin relación con WhatsApp/Chatwoot:

- Ruta `/api/messages` montada en `app.ts:1290` (`createMessagesRouter`).
- Modelo Prisma `Message` (`prisma/schema.prisma:151-168`): `subject/body/fromId/fromName/toId/toName/
  clientId/channel(default "internal")/status/threadId` — shape de mensajería INTERNA (más parecido a
  notas/email interno que a un chat), sin dirección inbound/outbound, sin ids externos, sin adjuntos.
- Use cases `ListMessages/GetMessage/CreateMessage/MarkMessageAsRead/DeleteMessage`
  (`src/application/use-cases/*Message*.ts`), routes en `src/infrastructure/http/routes/
  messages.routes.ts:1-79`.

El BACKLOG ya anticipa esto correctamente al proponer modelos nuevos (`Conversation`/`Message` los
NOMBRA él mismo en la decisión abierta #1, pero el nombre `Message` CHOCA con el modelo Prisma
existente). **Para F1 hace falta nombrar distinto** (p.ej. `Conversation` + `ChatMessage`/
`InboxMessage`, ruta `/api/messaging/*` en vez de `/api/messages/*`, que además es justo lo que el
BACKLOG ya sugirió para el webhook: `POST /api/messaging/webhook`). Esto es una CONFIRMACIÓN con
evidencia de código de que el naming del BACKLOG (`/api/messaging`) es el correcto — la única corrección
es ser explícito en el proposal de que NO se toca ni se reusa el módulo `Message`/`messages.routes.ts`
existente.

---

## Riesgos

1. **Sin precedente de verificación de webhook entrante** (punto 1) — riesgo de shippear un endpoint
   público sin autenticación real, permitiendo forjar mensajes "del cliente" en el inbox. Bloqueante:
   cerrar el mecanismo de auth del webhook ANTES de mergear F1, no después.
2. **`account_id` + `api_access_token` del agente Chatwoot NO están obtenidos todavía** (dato de contexto
   de la tarea, no del código) — el explore/proposal pueden avanzar, pero `sdd-apply` se va a bloquear en
   conseguir credenciales reales del panel de Chatwoot.
3. **Colisión de nombres** `/api/messages` + modelo `Message` ya existentes (ver sección arriba) — usar
   nombres distintos (`Conversation`/`ChatMessage`, prefijo `/api/messaging`).
4. **`app.ts` God Object** ya en 2509 líneas (4x el número documentado en `config.yaml`/`CLAUDE.md`) —
   agregar el wiring de `messaging` lo empeora más; no bloqueante pero hay que flaguearlo (la propia regla
   de `config.yaml` lo pide).
5. **Reuso de `listActiveContacts()`** trae TODOS los clientes activos a memoria por llamada — bien para
   un lookup puntual al abrir una conversación, mal si se llama sin memoizar por cada fila de una lista de
   conversaciones. A vigilar en el design, no bloqueante para F1.
6. **Ventana de 24h de WhatsApp**: hace falta que la API de Chatwoot exponga de alguna forma si "todavía
   se puede responder" (p.ej. timestamp del último mensaje entrante) para que la UI grisee el composer —
   esto NO es verificable desde el código de este repo, hay que confirmarlo contra la respuesta REAL de
   la API de Chatwoot corriendo en `.37` (no asumir de la doc genérica).
7. **`env.example` ya desactualizado** para 3 integraciones existentes (uisp/orchestrator/minio) — deuda
   preexistente no relacionada, pero conviene no repetirla al agregar `CHATWOOT_*`.

---

## Decisiones abiertas que el proposal debe cerrar

1. **Persist (mirror `Conversation`/`ChatMessage` en Prisma) vs proxy live a Chatwoot** — mi
   recomendación es mirror (sección 6), pero falta decidir el alcance del backstop de reconciliación en
   F1 (¿desde el día 1, o se acepta el riesgo de webhooks perdidos y se agrega después?).
2. **Mecanismo de auth del webhook entrante** — no hay patrón HMAC en este repo; decidir entre
   shared-secret estilo `apiKeyMiddleware` (en URL o header) + posible allowlist de IP origen, vs lo que
   realmente soporte la instancia Chatwoot corriendo en `.37` (verificar en vivo, no asumir).
3. **Estilo de config del adapter Chatwoot** — env estático (`HttpRadiusOrchestratorGateway`-style) vs
   DB-backed admin-configurable con feature flag (`GigaredClient`-style).
4. **Link `Client`→`NetworkSite`/UISP** — confirmado que no existe hoy; queda 100% para F2, ningún
   candidato es un FK limpio (sección 8).
5. **Set exacto de acciones RBAC** — confirmar `messaging.read/send/bulk/templates` (boceto BACKLOG) más
   `manage` (precedente en todos los demás módulos) antes de escribir la migración de seed.
6. **`account_id` + `api_access_token`** del agente Chatwoot — deben conseguirse operacionalmente (no es
   una decisión de código, pero bloquea el testing end-to-end).
7. **Nombre exacto del apartado** ("Mensajes" en la UI) — no colisiona con nada de FE (repo distinto),
   pero el BE debe usar `/api/messaging/*` y modelos NO llamados `Message` (confirmado arriba, sección de
   riesgo de colisión).
8. **Templates Meta a crear/aprobar** — explícitamente F2/F3, no F1; solo anotado para no perderlo.

---

## Ready for Proposal

**Sí** — la exploración está completa contra el código real. El boceto de arquitectura del BACKLOG
(`MessagingGateway`, `/api/messaging/webhook`, use cases F1, RBAC `messaging.*`) es CONSISTENTE con los
patrones existentes del repo (adapters HTTP, wiring en `app.ts`, catálogo RBAC, mirrors) y no contradice
ninguna decisión ya tomada. La única corrección de evidencia es la colisión de nombres con el módulo
`Message`/`messages.routes.ts` existente (ya cubierta por el prefijo `/api/messaging` que el propio
BACKLOG sugería, pero ahora CONFIRMADA como necesaria, no solo estilística).

**Next**: `sdd-propose`, con foco en cerrar las 8 decisiones abiertas de arriba — en particular #1
(persist vs proxy, con el alcance del backstop), #2 (auth del webhook, posible spike contra la instancia
real de Chatwoot en `.37` antes de comprometerse a un mecanismo) y #6 (conseguir credenciales reales).
