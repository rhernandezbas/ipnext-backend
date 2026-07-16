# Design — inbox-resolve

Decisiones con evidencia. Lo que ya existe (STATUS-1, F1.5-C) es LOCKED — este change no lo reabre.

---

## D1 — Scope re-baseado: no re-implementar Resolver/Reabrir

La visión original asumía crear `Conversation.status`, `ResolveConversation`/`ReopenConversation`,
el método del gateway y el manejo del webhook. **Todo eso ya existe** (ver tabla del proposal §2).
El costo de duplicarlo sería alto (dos use cases nuevos que clonan `SetConversationStatus`) y el
beneficio nulo. `SetConversationStatus` ya cumple exactamente el contrato pedido:

- Optimista LOCAL inmediato post-OK de Chatwoot (`SetConversationStatus.ts:63-66`), sin esperar el
  webhook.
- Si Chatwoot falla → `ChatwootUnavailableError` (503) SIN tocar el mirror (`:57-61`).
- El webhook `conversation_status_changed` reconcilia idempotente (`ReceiveChatwootWebhook.ts:390-398`;
  `upsertByChatwootId` solo con `status`, nunca pisa assignee/area — disciplina `updateLocalFields`,
  `ConversationRepository.ts:86-89`).

**El change es el ciclo de vida EN LA LISTA**: filtro BE + tabs/motion/undo FE.

## D2 — Semántica del filtro `?status=`: buckets, no match exacto para 'open'

`Conversation.status` es String passthrough del vocabulario de Chatwoot (`schema.prisma:2824-2827`).
Por webhook pueden llegar `pending` (inbox con bot) o `snoozed` — la UI de Prominense nunca los
setea (v1 solo dispara open/resolved, `types/whatsapp.ts:95-98`), pero el mirror los puede tener.

- `status=open` → `WHERE status != 'resolved'` (bucket ACTIVAS). Con match exacto, una conversación
  `pending`/`snoozed` desaparecería de LAS DOS tabs — inaceptable (fila invisible).
- `status=resolved` → `WHERE status = 'resolved'` (exacto).
- Ausente → sin filtro. **Back-compat**: misma convención "solo aplica cuando viene definido" que
  `assignment`/`campaignId` (`messaging.routes.ts:317-332`). El default del CONTRATO no cambia; el
  default VISUAL lo decide el FE mandando `status=open` explícito (D5).
- Valor desconocido → se ignora (mismo criterio que `assignment` con valor no reconocido).

Alternativa rechazada: param `?state=active|resolved` (nombre distinto al campo) — menos descubrible;
el vocabulario open/resolved ya es el del repo entero (tipo FE, badge, toggle).

Precedencia/combinación: `status` es un AND independiente de `assigneeId/unassigned/campaignId`,
sin interacción de precedencia (se suma al `where` de Prisma / al `filter` in-memory).

## D3 — Sin migración ni backfill

`status` existe desde `20260904000000_messaging_mirror` con `@default("open")`. Toda fila tiene
valor. Nada que migrar.

## D4 — Reopen ante mensaje inbound: CERO código BE (verificado contra el source de Chatwoot)

Pregunta de la visión: "si la conversación resuelta recibe mensaje nuevo del cliente → ¿Chatwoot la
reabre solo?" **SÍ — verificado 2026-07-16 contra `chatwoot/chatwoot` (branch develop)**:

1. `app/models/message.rb` — callback `reopen_conversation` post-create: `return unless incoming?`;
   si `conversation.resolved?` → reabre (muted → no reabre; inbox con bot → pasa a `pending`;
   inbox API → reabre si lo inició el contacto).
2. `app/models/conversation.rb` — CUALQUIER cambio de status (incluido el automático) dispara
   `CONVERSATION_STATUS_CHANGED` (`saved_change_to_status?` → `dispatcher_dispatch`), que llega a
   los webhooks suscriptos.
3. Nosotros estamos suscriptos a `conversation_status_changed`
   (`HttpChatwootGateway.ts:215`, `scripts/registerChatwootWebhook.ts:32`) y
   `handleConversationStatusChanged` reconcilia el mirror (`ReceiveChatwootWebhook.ts:390-398`).

Conclusión: el mirror vuelve a `open` solo, vía webhook. La fila reaparece en Abiertas en el
próximo poll de la lista (15s, `useWhatsapp.ts:62`).

**Alternativa rechazada**: forwardear `payload.conversation.status` en `handleMessageCreated` como
cinturón. Toca el write-path más sensible del sistema (verificado en vivo contra `.37`,
`ReceiveChatwootWebhook.ts:46-60`) para cubrir un caso que el evento dedicado ya cubre. Si un día
se observara pérdida sistemática del evento status_changed, se reevalúa — con evidencia.

**Edge muted**: conversación muteada en Chatwoot NO se reabre con inbound → el mensaje llega al
mirror (message_created) pero la conversación queda `resolved` → en la tab Resueltas con preview
nuevo. Es paridad exacta con Chatwoot; no se "corrige".

## D5 — FE: tabs como radiogroup segmentado, default Abiertas

Patrón EXISTENTE `ConversationAssignmentFilter` (`ConversationAssignmentFilter.tsx:22-27`): radios
nativos, NO `role="tab"` — cambia el FILTRO de una misma lista, no un panel distinto (navegación
por flechas gratis). Mismo molde: componente 100% controlado + pill indicator.

- `WhatsappPaginatedQuery.status?: 'open' | 'resolved'` (espejo del contrato BE).
- Estado inicial de la page: `{ status: 'open' }` (HOY es `{}` — `WhatsappInboxPage.tsx:94`). El
  cache key de React Query ya deriva del objeto query completo (`whatsappConversationsKey`,
  `useWhatsapp.ts:32-33`) → cada tab tiene su cache entry, `keepPreviousData` evita flicker.
- La tab Resueltas manda `status: 'resolved'`. No hay tab "Todas" en v1: el ciclo de vida de dos
  buckets es el feature; "Todas" diluye el concepto (Chatwoot tampoco la tiene como default).
  El BE la soporta igual (sin param) si hiciera falta después.

## D6 — Resolver directo + undo-toast (sin confirm)

Tradeoffs evaluados:

| Opción | Pro | Contra |
|---|---|---|
| Confirm modal | previene error | fricción en la acción MÁS frecuente del inbox; Chatwoot no confirma |
| Directo sin nada | cero fricción | un mis-click esconde la conversación y el agente no sabe a dónde fue |
| **Directo + undo-toast 5s (elegida)** | cero fricción + recovery inmediato | ninguna seria — el rollback ya existe (`setStatus('open')` idempotente) |

Además hay recovery DOBLE permanente: tab Resueltas → abrir → Reabrir (botón existente).

Implementación (spec, el detalle lo decide apply):
- Extender el mecanismo `inboxToast` existente (`WhatsappInboxPage.tsx:191-198`) a una variante con
  acción (`{ message, action? }`) — NO se instala ToastContext global (el repo no tiene; convención
  documentada en `WhatsappInboxPage.tsx:170-174`).
- El "Deshacer" captura `convId` AL DISPATCH (misma disciplina que `useSetConversationStatus`
  deriva keys de `vars.convId`, `useWhatsapp.ts:269-274` — memoria `inbox-key-por-conversacion`).
- El efecto existente que limpia el toast al cambiar de conversación (`WhatsappInboxPage.tsx:243-249`)
  aplica también al undo-toast (un undo de la conversación A visible sobre la B sería el mismo bug
  de contaminación que ya nos mordió dos veces).
- El toast de ERROR existente queda intacto.

## D7 — Transición de salida (motion spec)

Al resolver desde la tab Abiertas, el optimista de `useSetConversationStatus` ya parchea `status`
en todas las páginas cacheadas de la lista (`useWhatsapp.ts:310-327`). Con un filtro client-side
por bucket en `ConversationList` (cinturón sobre el filtro server-side, que sigue siendo la fuente
de verdad en cada refetch), la fila deja de matchear EN EL INSTANTE del click → eso habilita la
animación de salida sin esperar red.

Spec de motion (el detalle exacto lo implementa apply con las skills de Emil/impeccable):
- Salida: colapso de altura + fade (opacity), 200-250ms, ease-out. La fila no debe "saltar" — las
  siguientes suben acompañando el colapso.
- `prefers-reduced-motion: reduce` → remoción instantánea sin animación (patrón ya presente en el
  repo: `WhatsappInboxPage.module.css` y 9+ módulos CSS del inbox usan `@keyframes` +
  `prefers-reduced-motion`; NO hay framer-motion y no se agrega).
- Disciplina de keys INTACTA: `key={conv.id}` por fila (`ConversationList.tsx:136` — regla del
  repo, memoria `inbox-key-por-conversacion`).
- Si la mutation falla, el rollback field-scoped restaura `status` → la fila re-entra (la
  animación de entrada puede ser el mismo colapso invertido o instantánea — a criterio de apply).

## D8 — El thread NO se cierra al resolver

Paridad Chatwoot: resolver mantiene la conversación abierta en el panel del thread (el badge pasa a
Resuelta + botón Reabrir). `selectedId` no se toca ni al resolver ni al cambiar de tab. El header
ya no depende de que la fila esté en la lista: `contactNameFallback` cae al `detail`
(`WhatsappInboxPage.tsx:273-274`) — la desaparición de la fila no rompe nada.

## D9 — Permisos: sin cambios

- Ver lista/tabs → `messaging.read` (`perms.read` en `GET /conversations`, `messaging.routes.ts:313`).
- Resolver/Reabrir/Deshacer → `messaging:send` (guard existente de `POST /conversations/:id/status`,
  `messaging.routes.ts:440-447`; test 403 en `messaging.routes.test.ts:272`).

Decisión documentada (pedida por la visión): **cualquier operador del inbox que puede escribir
puede resolver** — mismo permiso que operar la conversación. No se crea `messaging.resolve`:
resolver es parte del flujo operativo de responder, no una acción administrativa; y el botón FE ya
está gateado por `<Can permission="messaging.send">` en el header del thread.

## D10 — Caches y polling (sin cambios estructurales)

- `whatsappConversationsKey(query)` ya discrimina por el objeto query completo → el status entra
  gratis al cache key.
- El optimista de status ya cubre TODAS las páginas cacheadas vía `WHATSAPP_CONVERSATIONS_ROOT`
  (`useWhatsapp.ts:313,320-327`) — incluye ambas tabs.
- `onSettled` ya invalida lista+detalle → ambas tabs refetchean y el server-side filter asienta la
  verdad final.
- Poll de lista 15s / detalle 25s intactos.

## Colisiones con changes en vuelo (verificado)

- **FE `fix/bulk-send-polling`** (change `bulk-detail-polling-fe`, 2 commits sobre main): toca
  `useBulkMessaging.ts`, `BulkMessagingPage.tsx` y componentes de bulk (composer/detail/history).
  **NO toca `WhatsappInboxPage.tsx`** ni nada de `WhatsappInboxPage/components/` ni
  `types/whatsapp.ts` (verificado `git diff main...fix/bulk-send-polling --name-only`). El cambio
  de firma de `useCampaigns` es aditivo (`(query, enabled, poll=false)`) — el call site del inbox
  (`WhatsappInboxPage.tsx:159`) compila y se comporta igual. **Orden de merge libre; cero conflicto
  de archivos.** Nota: el reporte inicial de colisión ("hoy se tocó WhatsappInboxPage.tsx en
  bulk-detail-polling") NO se sostiene contra el branch actual — quizás una versión intermedia lo
  tocó y los review fixes lo revirtieron.
- **BE**: `feat/inbox-resolve` nace de main (`5d0673d6`); ningún otro change en vuelo toca
  messaging en BE.
