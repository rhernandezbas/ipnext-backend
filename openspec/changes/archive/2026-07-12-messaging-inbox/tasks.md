# Tasks — messaging-inbox (F1 Inbox WhatsApp/Chatwoot)

TDD: rojo→verde. Task↔scenario spec.

## B1 — Modelo + migraciones ⚠️ revisar SQL con usuario
- [x] 1.1 `schema.prisma`: +`Conversation`/`ChatMessage`/`WebhookDelivery` (design §1)
- [x] 1.2 Migración `20260904000000_messaging_mirror` (3 tablas + índices)
- [x] 1.3 Migración `20260904000100_messaging_permissions` (clona `20260903000000_actions_permissions`:
      módulo `messaging`, permisos `read`/`send`, grants `super_admin`/`administrador`) — RBAC-3
- [x] 1.4 `rbac.ts`: +`'messaging'` en `RBAC_MODULES`, +`'send'` en `KNOWN_ACTIONS`
- [x] 1.5 `domain/errors/messaging.ts`: 3 errores (NotFound/WindowExpired/ChatwootUnavailable)
- [x] 1.6 `errorHandler.ts`: +3 entradas `statusMap` (404/422/503)
- [x] 1.7 Test: migración corre 2x sin duplicar (RBAC-3)

## B2 — Ports + repos in-memory + Prisma (dep. B1)
- [x] 2.1 4 ports: `ConversationRepository`/`ChatMessageRepository`/`WebhookDeliveryRepository`/
      `ChatwootGateway` (design §3-4)
- [x] 2.2 TDD in-memory: `InMemoryConversation`/`ChatMessage`/`WebhookDelivery`
- [x] 2.3 `recordIfNew`: `create()` + catch `P2002`→false (estilo `sourceContractId`)
- [x] 2.4 Prisma: 3 repos, contrato in-memory (compilan; NO unit-testeados por decisión de diseño — se
      ejercitan en integración)

## B3 — HttpChatwootGateway + config (dep. B2)
- [ ] 3.1 `config.ts`: bloque `chatwoot` opt-in (estilo iclass)
- [ ] 3.2 `env.example`: bloque `CHATWOOT_*`
- [ ] 3.3 TDD `HttpChatwootGateway` (mock axios): 4 métodos, error axios→`ChatwootUnavailableError`
- [ ] 3.4 Implementación (clona `HttpRadiusOrchestratorGateway` :32-45, sin retry)

## B4 — Use cases TDD in-memory (dep. B1+B2+B3-interfaz)
- [ ] 4.1 `ReceiveChatwootWebhook`: dedup (HOOK-3), 3 eventos (HOOK-4), evento desconocido no-op
      (HOOK-5), `message_type` 0/1 in/out vs 2/3 activity/template→skip, contacto=
      `meta.sender.phone_number`
- [ ] 4.2 `GetClientContextByPhone`: matched/unknown/ambiguous/basura (CTX-1 x4), reusa
      `normalizePhone`/`suffixMatch`
- [ ] 4.3 `ListConversations`: orden `lastMessageAt` DESC + paginación (INBOX-1 x2)
- [ ] 4.4 `GetConversation` fetch-on-open: sync trae mensajes, Chatwoot caído→swallow+200, 404,
      `canReply` refresca (INBOX-2 x3 + CTX-2)
- [ ] 4.5 `ListMessages`: historial ASC + 404 guard (INBOX-3 x2)
- [ ] 4.6 `SendMessage`: dentro ventana (SEND-1), fuera/sin inbound→422 (SEND-2 x2), Chatwoot
      caído→503 sin upsert (SEND-3), `canReply` del mirror, nunca 24h local
- [ ] 4.7 `application/dto/messaging.ts`: 4 DTOs (design §5)

## B5 — HMAC + raw-body (dep. B3-config; paralelo a B4) ⚠️ seguridad
- [ ] 5.1 TDD `chatwootSignatureMiddleware`: válida (esc1), inválida→401 (esc2), sin rawBody→
      fail-closed (esc3), ventana ±5min ok/viejo/futuro (HOOK-2 x3), secret vacío→401
- [ ] 5.2 Implementación: `HMAC-SHA256(secret,"ts.body")` sobre raw body + `timingSafeEqual`

## B6 — Router + wiring app.ts + RBAC ⚠️ toca app.ts (god-object) — dep. B1-B5
- [ ] 6.1 `messaging.routes.ts`: factory+perms (estilo `actions.routes.ts`), 5 rutas,
      `try/catch→next(err)` (ROB-1)
- [ ] 6.2 TDD supertest: RBAC 403 read/send (RBAC-1/2), webhook sin sesión solo HMAC (RBAC-4), repo
      lanza→`next(err)` (ROB-1)
- [ ] 6.3 `app.ts`: `express.json` c/ `verify: rawBody` en `/api/messaging/webhook` ANTES de `:830`
- [ ] 6.4 `app.ts`: mount bloque junto a `actions` (~:2420) — wiring repos+gateway+router
- [ ] 6.5 Test: mount router + statusMap pins

## B7 — Deploy wiring (dep. B3, final)
- [ ] 7.1 `deploy.yml`: 5 líneas `CHATWOOT_*` (junto a `MINIO_*` :102-107)
- [ ] 7.2 `scripts/registerChatwootWebhook.ts` (one-shot, sin wiring app.ts)
- [ ] 7.3 Operativo: `gh secret set` x5 + correr script contra Chatwoot real (`.37`)

## Gates finales
- [ ] G.1 Suite completa (`npm test`) + `tsc --noEmit` tras cada batch
- [ ] G.2 Review adversarial (HMAC, wiring app.ts, migración RBAC)
- [ ] G.3 Deploy con OK del usuario (2 migraciones) + registro webhook real + verify end-to-end
