# Proposal — inbox-resolve (ciclo de vida de conversaciones en el inbox, estilo Chatwoot)

## 1. Why / Intent

El inbox WhatsApp de Prominense (`/admin/whatsapp`) no tiene ciclo de vida VISIBLE: la lista muestra
todas las conversaciones para siempre, mezcladas, sin importar su estado. La visión (usuario,
2026-07-16) es replicar la UX de Chatwoot: **"Resolver" saca la conversación de la vista activa**,
con tabs Abiertas/Resueltas y posibilidad de reabrir. Chatwoot sigue siendo el motor — la fuente de
verdad del estado es Chatwoot.

## 2. Hallazgo clave que re-basea el scope (evidencia)

**Resolver/Reabrir YA EXISTE end-to-end** — lo entregó el change `messaging-inbox-productivity`
(F1.5 fase C, STATUS-1). NO se re-implementa nada de esto:

| Pieza | Evidencia (file:line) |
|---|---|
| `Conversation.status` en el mirror (String, default `'open'`, passthrough vocabulario Chatwoot) | `prisma/schema.prisma:2824` — sin migración pendiente |
| Use case `SetConversationStatus` (valida → 404 → Chatwoot → upsert mirror POST-OK; si Chatwoot falla → `ChatwootUnavailableError` 503 SIN tocar el mirror) | `src/application/use-cases/messaging/SetConversationStatus.ts:38-70` |
| Port `ChatwootGateway.setStatus` + adapter con `POST .../conversations/{id}/toggle_status` (Application API, header `api_access_token`) | `src/domain/ports/ChatwootGateway.ts:121`, `src/infrastructure/adapters/chatwoot/HttpChatwootGateway.ts:227-231` |
| Ruta `POST /conversations/:id/status` gateada por `messaging:send` | `src/infrastructure/http/routes/messaging.routes.ts:440-461`; test 403: `messaging.routes.test.ts:272` |
| Webhook `conversation_status_changed` suscripto + handler idempotente + dedup key con timestamp firmado (oscilaciones open↔resolved) | `ReceiveChatwootWebhook.ts:150-151,390-398`; `HttpChatwootGateway.ts:215`; `messaging.routes.ts:234-235` |
| DTO expone `status` | `src/application/dto/messaging.ts:41,252` |
| FE: botón Resolver/Reabrir + badge en el header del thread (a11y hint ventana 24h) | FE `ConversationStatusToggle.tsx:34-67`, montado vía `WhatsappInboxPage.tsx:310-312` |
| FE: `useSetConversationStatus` con optimistic UI + rollback field-scoped + invalidación | FE `useWhatsapp.ts:297+`; API client `whatsapp.api.ts:145-151` |
| FE: toast de error si el POST falla | FE `WhatsappInboxPage.tsx:55,200-202` |

**Lo que FALTA (el change real)** — el ciclo de vida EN LA LISTA:

1. **BE**: `GET /conversations` NO filtra por status — `ConversationListQuery` solo tiene
   `assigneeId/unassigned/campaignId` (`src/domain/ports/ConversationRepository.ts:68-76`); la ruta
   solo parsea `page/limit/assignment/campaignId` (`messaging.routes.ts:309-339`); los `list()` de
   Prisma e InMemory no conocen status (`PrismaConversationRepository.ts:262-272`,
   `InMemoryConversationRepository.ts:228-241`).
2. **FE**: la lista muestra TODO mezclado (`ConversationList.tsx:74-81` — solo search client-side +
   sort); no hay tabs por estado, ni transición de salida al resolver, ni undo.

## 3. Scope IN

### BE (este repo, branch `feat/inbox-resolve`)
- **B1**: `ConversationListQuery.status?: 'open' | 'resolved'` con semántica de BUCKET:
  `'open'` = activas (`status != 'resolved'` — incluye `pending`/`snoozed` passthrough, nada
  desaparece de ambas tabs), `'resolved'` = match exacto. Ausente = sin filtro (back-compat,
  misma convención que `assignment`/`campaignId`). Implementado en InMemory + Prisma `list()`.
- **B2**: parsing de `?status=` en `GET /conversations` (valor desconocido → se ignora, mismo
  criterio que `assignment`, `messaging.routes.ts:328-332`). Combinable con `assignment` y
  `campaignId`.
- **B3**: verificación/extensión de tests de reconciliación: reopen automático de Chatwoot
  (mensaje inbound sobre resuelta) llega como `conversation_status_changed` y el mirror vuelve a
  `open` — **cero código nuevo en el webhook** (ver design D4, verificado contra el source de
  Chatwoot).

### FE (repo `ipnext-frontend`, branch nuevo `feat/inbox-resolve-fe`)
- **F1**: tabs **Abiertas | Resueltas** en la lista (radiogroup segmentado, patrón
  `ConversationAssignmentFilter`), default Abiertas; viaja como `?status=` server-side.
- **F2**: al resolver desde la tab Abiertas, la fila SALE de la lista con transición de salida
  (altura+opacidad, 200-250ms ease-out, `prefers-reduced-motion` respetado). El thread queda
  abierto (paridad Chatwoot).
- **F3**: undo-toast al resolver ("Conversación resuelta · Deshacer", 5s) — resolver directo SIN
  confirm (ver design D6). Reabrir explícito sigue disponible (header + tab Resueltas).
- **F4**: empty states por tab.

## 4. Scope OUT

- Estado `pending`/`snoozed` como tab propia o control de UI (el tipo ya lo contempla; ningún
  control lo dispara — igual que hoy, `types/whatsapp.ts:95-98`).
- Contadores/badges por tab (necesitaría query extra por tab; se evalúa después con uso real).
- Push/realtime: la arquitectura es polling (lista 15s) — el movimiento entre buckets por webhook
  se ve en el próximo poll.
- Permiso nuevo para resolver: se mantiene `messaging:send` (decisión documentada, design D9).
- Cambios de schema/migraciones: `status` existe desde `20260904000000_messaging_mirror` con
  default `'open'` — no hay backfill pendiente.
- Tocar `handleMessageCreated`/write-path del webhook (design D4, alternativa rechazada).

## 5. Riesgos

- **R1 (bajo)**: cambiar el default VISUAL del FE (Abiertas) esconde las resueltas de la vista
  default — es el feature pedido; el contrato BE queda back-compat (sin param = todo).
- **R2 (bajo)**: conversaciones `origin:'bulk'` no adoptadas (`chatwootConversationId: null`) no
  pueden resolverse (`SetConversationStatus.ts:54-55` → 404) — hoy ya es así; quedan en Abiertas
  hasta que Fase 2 las adopte. Documentado como edge, sin cambio.
- **R3 (bajo)**: colisión FE con `fix/bulk-send-polling` (bulk-detail-polling) — **verificada
  NULA**: ese branch NO toca `WhatsappInboxPage.tsx` ni componentes del inbox (verificado con
  `git diff main...fix/bulk-send-polling --name-only`); su cambio a `useCampaigns` es aditivo
  (3er param `poll` con default). Orden de merge libre.
