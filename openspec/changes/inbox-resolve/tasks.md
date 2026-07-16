# Tasks — inbox-resolve

**Change**: inbox-resolve · **Phase**: tasks
**Repos**: BE = este worktree (`feat/inbox-resolve`); FE = `ipnext-frontend` (branch NUEVO
`feat/inbox-resolve-fe` desde main — crear al arrancar el Batch 3).
**TDD estricto**: test que falla PRIMERO, mínimo código, refactor. Correr SOLO los archivos de
test afectados durante el loop; el gate completo (`npm test`) al cierre de cada batch.
**Colisiones**: `fix/bulk-send-polling` (FE) NO comparte archivos con este change (verificado,
design §Colisiones) — orden de merge libre. Ningún change BE en vuelo toca messaging.

---

## Batch 1 — BE: filtro `status` en el listado (LS-1)

- [x] **T1 — InMemory: bucket filter** (LS-1)
  - Test RED: `src/__tests__/infrastructure/adapters/in-memory/InMemoryConversationRepository.test.ts`
    — bucket open (incluye `pending`, excluye `resolved`), resolved exacto, sin param = todo,
    combinable con `assigneeId`/`campaignId`, `total`/paginación sobre el filtrado.
  - Código: `ConversationListQuery.status?: 'open' | 'resolved'`
    (`src/domain/ports/ConversationRepository.ts`, doc de semántica de bucket en el JSDoc) +
    filtro en `InMemoryConversationRepository.list` (después de campaña, antes del sort).
- [x] **T2 — Prisma: mismo where** (LS-1)
  - Test RED: patrón de `PrismaConversationRepository.orderBy.test.ts` — el `where` incluye
    `status: { not: 'resolved' }` para open y `status: 'resolved'` para resolved; ausente no
    agrega clave.
  - Código: `PrismaConversationRepository.list` — MISMO comment-block cross-ref al in-memory que
    ya usan assignment/campaña (los dos adapters no pueden divergir).
- [x] **T3 — use case passthrough** (LS-1)
  - Test RED: `src/__tests__/application/messaging/ListConversations.statusFilter.test.ts`
    (naming espejo de `ListConversations.campaignFilter.test.ts`) — el query llega al repo tal
    cual; DTO expone `status` (ya existente, asertar no-regresión).
  - Código: NINGUNO esperado (`ListConversations` ya es passthrough) — el test lo demuestra.

## Batch 2 — BE: ruta + reconciliación (LS-2, LS-3)

- [x] **T4 — parsing `?status=`** (LS-2)
  - Test RED: `src/__tests__/infrastructure/messaging.routes.test.ts` — `?status=open`,
    `?status=resolved`, `?status=banana` (ignorado), combinado con `assignment=mine`.
  - Código: `messaging.routes.ts` GET /conversations — `firstQueryValue` + whitelist
    `open|resolved` (mismo criterio que `assignment`). Guard `perms.read` intacto.
- [x] **T5 — reopen reconcilia (verificación)** (LS-3)
  - Revisar `ReceiveChatwootWebhook.reconciliation.test.ts`: si el caso
    "resolved + `conversation_status_changed`(open) → mirror open, sin tocar assignee/area" no
    existe explícito, agregarlo (test-only; CERO código de producción — design D4).
- [ ] **Gate Batch 1+2**: `npm test` completo BE verde. *(Lo corre el ORQUESTADOR serializado —
  race conocido: worktrees comparten node_modules por junction y el pretest `prisma generate`
  pisa tipos de gates paralelos. Tests dirigidos del change: 8 suites / 179 tests verdes +
  `npx tsc --noEmit` limpio, 2026-07-16.)*

## Batch 3 — FE: tipos + API + tabs (API-1, TAB-1, TAB-4)

- [ ] **T6 — tipos + api client** (API-1)
  - Test RED: `src/__tests__/api/whatsapp.api.test.ts` — `status` viaja solo si definido.
  - Código: `WhatsappPaginatedQuery.status?: 'open' | 'resolved'` (`types/whatsapp.ts`) + param en
    `listWhatsappConversations` (`api/whatsapp.api.ts`).
- [ ] **T7 — `ConversationStatusFilter` (tabs)** (TAB-1)
  - Test RED: componente nuevo `ConversationStatusFilter.test.tsx` — radiogroup 2 segmentos
    Abiertas/Resueltas, controlado, default por props.
  - Código: clon estructural de `ConversationAssignmentFilter` (radios nativos + pill), montado en
    `ConversationList` arriba del filtro de asignación.
- [ ] **T8 — wiring page + default open + empty states** (TAB-1, TAB-4)
  - Test RED: `WhatsappInboxPage.test.tsx` — estado inicial `{ status: 'open' }` llega a
    `useWhatsappConversations`; cambiar tab manda `resolved`; filtros existentes no se resetean.
    `ConversationList.test.tsx` — empty states por tab.
  - Código: `WhatsappInboxPage.tsx` (`useState<WhatsappPaginatedQuery>({ status: 'open' })` +
    handler) + textos de empty state en `ConversationList`.

## Batch 4 — FE: bucket client-side + motion + undo (TAB-2, TAB-3, MOTION-1, UNDO-1)

- [ ] **T9 — filtro client-side de cinturón** (TAB-2, TAB-3)
  - Test RED: `ConversationList.test.tsx` — fila resuelta (optimista) sale de Abiertas sin
    refetch; rollback la re-entra. `WhatsappInboxPage.test.tsx` — `selectedId`/thread sobreviven
    al resolve y al cambio de tab.
  - Código: predicado de bucket en el `useMemo` de `visible` (`ConversationList.tsx:74-81`),
    `key={conv.id}` intacto.
- [ ] **T10 — transición de salida** (MOTION-1)
  - Test RED: comportamiento (fila removida; con `prefers-reduced-motion` remoción inmediata —
    mock de matchMedia, patrón de los tests de contraste/motion existentes).
  - Código: CSS modules (altura+opacity 200-250ms ease-out + `prefers-reduced-motion`), técnica a
    criterio de apply CON las skills de motion (Emil / impeccable) cargadas ANTES de escribir.
- [ ] **T11 — undo-toast** (UNDO-1)
  - Test RED: `WhatsappInboxPage.test.tsx` — resolver → toast con "Deshacer"; click → dispatch
    `setStatus('open')` del convId capturado; expira a los ~5s; se descarta al cambiar de
    conversación; el toast de ERROR sigue funcionando.
  - Código: extender `inboxToast` a `{ message, action? }` + captura de convId al dispatch.
- [ ] **Gate Batch 3+4**: `npm test` completo FE verde.

## Batch 5 — Verificación E2E en vivo (innegociable — memoria `e2e-envelope-mock-mismatch`)

- [ ] **T12 — E2E vivo del ciclo completo** (deuda de mocks: los tests mockeados no cazan
  mismatches de envelope; el API envuelve la lista en el envelope paginado)
  - Con BE+FE levantados contra Chatwoot real: resolver desde el inbox → sale de Abiertas con
    animación → aparece en Resueltas; Deshacer → vuelve; Reabrir desde el header → vuelve.
  - Reopen automático: resolver una conversación y mandar un mensaje INBOUND real (WhatsApp) →
    verificar en logs que llega `conversation_status_changed` y la fila reaparece en Abiertas en
    el próximo poll (≤15s). Esto valida en VIVO el design D4 (verificado hasta ahora solo contra
    el source de Chatwoot).
  - `GET /conversations?status=open|resolved|banana` a mano (curl) contra el BE local.
- [ ] **T13 — coordinación de merge**: si `fix/bulk-send-polling` ya mergeó, rebase trivial
  (sin archivos compartidos); si no, merge independiente — verificado sin colisión.
