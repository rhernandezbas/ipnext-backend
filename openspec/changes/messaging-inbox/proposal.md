# Proposal — messaging-inbox (EPIC Mensajería omnicanal WhatsApp en Prominense, F1)

## Intent

Prominense pasa a ser **front sobre Chatwoot** (motor ya en prod: Twilio/WhatsApp, VPS `.37`,
`chat.prometheus-alpha.xyz`, `account_id=2`, `inbox_id=1`, agente ronald@ipnext.net.ar con
`api_access_token` ya emitido). Hoy los agentes trabajan WhatsApp directo en Chatwoot, sin
contexto de cliente (deuda/contratos) ni RBAC de Prominense. F1 = **INBOX**: lista de
conversaciones + thread + historial + panel de contexto (match teléfono→`Client`) + responder
dentro de la ventana de 24h de WhatsApp Business. Bulk/segmentación por nodo/templates = F2,
fuera de F1.

## What

1. Port `MessagingGateway` + adapter `ChatwootGateway` (estilo `HttpRadiusOrchestratorGateway`:
   token estático, sin retry/backoff, sin config DB-backed). Métodos: listConversations,
   getConversation, listMessages, sendMessage.
2. `POST /api/messaging/webhook` — **primer webhook entrante de este backend** (todo lo
   existente es PULL o saliente). Recibe `message_created` de Chatwoot.
3. Mirror Prisma `Conversation`/`ChatMessage` (NO `Message` — colisiona con modelo+ruta
   `/api/messages` existentes), upsert al recibir webhook, patrón mirror de GR/UISP/PPPoE.
4. Use cases: `ListConversations`, `GetConversation` (+ fetch-on-open sync), `ListMessages`,
   `SendMessage` (gatea por ventana 24h), `ReceiveChatwootWebhook`, `GetClientContextByPhone`
   (reusa `normalizePhone`/`suffixMatch`/`matchActiveClient` de recapture +
   `CustomerRepository.listActiveContacts()`).
5. RBAC módulo `messaging`: acciones `read`/`send` en F1 (`bulk`/`templates` recién en F2).
   Migración clonando el patrón idempotente de `20260903000000_actions_permissions`.
6. Wiring en `app.ts` (router + DI) — suma a `known_debt: god-object-app`.
7. FE (repo separado): apartado "Mensajes", layout 3 paneles (lista/thread/contexto) vía
   `ui-ux-pro-max` + micro-interacciones de envío/recepción.
8. Chatwoot: registrar el webhook hacia Prominense + secret compartido.
9. Deploy: 5 secrets nuevos (`CHATWOOT_BASE_URL/ACCOUNT_ID/API_TOKEN/INBOX_ID/WEBHOOK_SECRET`)
   vía `gh secret` + `deploy.yml`, opt-in en `config.ts` (boot no falla si faltan).

## Decisions — recomendadas, A CONFIRMAR por el usuario

- **Persistencia = MIRROR** (`Conversation`/`ChatMessage`), no proxy live.
- **Backstop = fetch-on-open** (al abrir una conversación, re-sync idempotente contra la API);
  reconciliación completa por cron queda para un follow-up. Trade-off: un webhook perdido en
  una conversación que nunca se reabre deja un gap permanente — aceptable para F1.
- **Auth del webhook = shared secret** (URL o header, patrón `apiKeyMiddleware`) + posible
  allowlist de IP `.37`. No hay HMAC nativo confirmado en Chatwoot desde este repo — **validar
  contra la instancia real antes de mergear** (riesgo #1, bloqueante).
- **Config del adapter = estática** (env vars), no DB-backed/feature-flag (`GigaredClient`-style).
- **RBAC F1 = `messaging.read`+`messaging.send`** únicamente.

Decisión YA confirmada por evidencia de código (no re-abrir): naming `Conversation`/
`ChatMessage` + prefijo `/api/messaging` — colisión real con `Message`/`/api/messages`.

## Out of scope (F2+)

- Bulk send / segmentación por nodo o estado.
- Templates de WhatsApp aprobados por Meta.
- Link `Client`→`NetworkSite` (hoy no existe ningún FK limpio — confirmado en explore).
- Cron de reconciliación completa / cursor de catch-up.
- Permisos `messaging.bulk`/`messaging.templates`.

## Capabilities (para sdd-spec)

Un único delta `specs/messaging-inbox/spec.md` con capabilities:
- **ingesta de webhook Chatwoot** (auth + upsert mirror + idempotencia)
- **inbox de conversaciones** (list/thread/historial + fetch-on-open)
- **envío dentro de ventana 24h**
- **contexto de cliente por teléfono**
- **RBAC messaging** (read/send)

## Risks / flags

1. **Auth del webhook** sin precedente HMAC en el repo — validar contra Chatwoot real en `.37`
   antes de mergear. BLOQUEANTE.
2. Ventana 24h depende de que la API de Chatwoot exponga el timestamp del último inbound —
   confirmar contra la respuesta real, no la doc genérica.
3. **Toca `app.ts`** (ya 2509 líneas, 4x lo documentado en `config.yaml`) → `known_debt
   god-object-app`, empeora con este módulo.
4. `listActiveContacts()` trae TODOS los clientes activos por llamada — ok para un lookup de
   panel, vigilar si se memoiza por request en listas.
5. Credenciales Chatwoot (`account_id`/`api_access_token`) ya existen para build, pero registrar
   el webhook + secret es dependencia operativa para el testing end-to-end.
