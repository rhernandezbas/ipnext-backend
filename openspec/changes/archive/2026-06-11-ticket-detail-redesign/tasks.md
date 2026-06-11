# Tasks: Ticket Detail Redesign + Persisted Comments (#44)

> STRICT TDD — each unit: [RED] write failing test → [GREEN] make it pass → [REFACTOR] clean up.
> Multi-repo: BE phases run first; FE phases start after wire contract is frozen.
> BE test runner: `jest --runInBand`. FE: `vitest`.

---

## Phase 1 — BE Foundation (DB + Domain)

- [x] 1.1 [RED] `__tests__/application/ticketComments.dto.test.ts` — failing tests for Zod schema: data-URI ok, malformed, mime-mismatch, >2MB decoded, sizeBytes-mismatch, 4 attachments, empty body+attachments, image-only ok
- [x] 1.2 `prisma/schema.prisma` — add `TicketComment` + `TicketCommentAttachment` models (mirror lines 1332–1355; `ticketId FK→Ticket cascade`, no `authorId`)
- [x] 1.3 `prisma/migrations/20260628000000_add_ticket_comments/migration.sql` — aditiva, sin `BEGIN`/`COMMIT`, FK a `"Ticket"` cascade
- [x] 1.4 `src/domain/entities/ticketComment.ts` — mirror `taskComment.ts`
- [x] 1.5 `src/domain/entities/ticket.ts` — add optional `tasks?: Array<{id:string; sequenceNumber:number; title:string}>`
- [x] 1.6 `src/domain/ports/TicketCommentRepository.ts` — interface: `listByTicket(ticketId): Promise<TicketComment[]>` + `create(comment): Promise<TicketComment>`
- [x] 1.7 [GREEN] `src/application/dto/ticketComments.dto.ts` — implement Zod schema (snippet verbatim from design); run dto tests → green

## Phase 2 — BE Application + Adapters

- [x] 2.1 [RED] `__tests__/application/TicketComments.test.ts` — failing: `ListTicketComments` list ASC, `AddTicketComment` roundtrip, `TicketNotFoundError` en ambos (InMemory repos)
- [x] 2.2 `src/infrastructure/adapters/in-memory/InMemoryTicketCommentRepository.ts` — parity with port
- [x] 2.3 `src/application/use-cases/ListTicketComments.ts` — receives `TicketCommentRepository` + `TicketRepository`; throws `TicketNotFoundError` on 404
- [x] 2.4 `src/application/use-cases/AddTicketComment.ts` — receives both repos; validates ticket exists; no activity recorder
- [x] 2.5 [GREEN] run use-case tests → green
- [x] 2.6 `src/infrastructure/adapters/prisma/PrismaTicketCommentRepository.ts` — mirror `PrismaTaskCommentRepository`; `orderBy: {createdAt: 'asc'}`, include attachments
- [x] 2.7 `src/infrastructure/adapters/prisma/PrismaTicketRepository.ts` — `getById` include `tasks: { select: { id, sequenceNumber, title } }`

## Phase 3 — BE HTTP Layer + Wiring

- [x] 3.1 [RED] `__tests__/infrastructure/ticketComments.routes.test.ts` — failing: 200[], 201, 404, 422×4, 403 (stub perms), 413 (mini-app `limit:'1kb'` + errorHandler, body 2kb); mirror `taskComments.routes.test.ts`
- [x] 3.2 [RED] `__tests__/infrastructure/ticket-comments-composition.test.ts` — static assertions: (1) `indexOf('8mb') < indexOf('app.use(express.json())')` in `app.ts` source; (2) `createTicketCommentsRouter(` present with `requirePerm('tickets','read'/'write')`; (3) absence of `ticketRepliesStore` and `/replies`
- [x] 3.3 `src/infrastructure/http/middleware/errorHandler.ts` — add `entity.too.large` → 413 branch BEFORE DomainError check
- [x] 3.4 `src/infrastructure/http/routes/ticketComments.routes.ts` — `createTicketCommentsRouter(list, add, auth, {read,write})`; try/catch + `next(err)` on all handlers
- [x] 3.5 `src/infrastructure/http/routes/tickets.routes.ts` — remove `TicketReply`, `ticketRepliesStore`, `nextReplyId` (lines 62–76) and `/:id/replies` routes (285–320)
- [x] 3.6 `src/infrastructure/http/app.ts` — (a) path-scoped parser BEFORE global (pre-line 603); (b) wire `PrismaTicketCommentRepository` + `createTicketCommentsRouter` at ~line 1007 (snippet verbatim from design)
- [x] 3.7 [GREEN] run routes + composition tests → all green

## Phase 4 — FE Foundation (types + api + hooks)

- [x] 4.1 Fix `ticket.id: string` — `src/types/ticket.ts` lines 14, 21; delete `TicketReply` (58–66); `src/api/tickets.api.ts` lines 96, 103 (`number→string`); `src/hooks/useScheduling.ts:80`; `src/types/scheduling.ts:53,161`; `CreateTaskModal.tsx:46`; `TaskTabs.tsx:27,85,97–98`; update fixtures in `__tests__/tickets/TicketDetailPage.test.tsx`
- [x] 4.2 `src/hooks/useTickets.ts` — remove `useTicketReplies` (61–66) and `useAddTicketReply` (68–77)
- [x] 4.3 `src/types/ticketComments.ts` — mirror taskComments types; wire contract shape verbatim
- [x] 4.4 `src/api/ticketComments.api.ts` — base `/tickets`, `GET /:id/comments`, `POST /:id/comments`
- [x] 4.5 `src/hooks/useTicketComments.ts` — queryKey `['ticket-comments', id]`, invalidate only its key; no activity feed

## Phase 5 — FE Components

- [x] 5.1 [RED] `__tests__/tickets/TicketCommentsTimeline.test.tsx` — failing: paste → chip (FileReader + waitFor); >2MB/4th/PDF → spec messages; submit → payload shape (mock api); composer hidden without `tickets.write`; boundary mock axios: URL + shape
- [x] 5.2 `TicketDetailPage/components/TicketCommentsTimeline.tsx` + `.module.css` — fork of `TaskCommentsTimeline`; replace `isImageUrl` regex with `url.startsWith('data:image/')`; add Composer (paste handler, file input, previews, `addFiles` validates type/2MB/max3, aria-live="polite"); remove delete button; remove "Adjuntar URL"
- [x] 5.3 `TicketDetailPage/components/TicketTabs.tsx` + `.module.css` — Tabs molecule: Conversación (default) | Datos (`white-space: pre-wrap`, placeholder "Sin descripción") | Relacionado (mirror `RelacionadoPanel` from `TaskTabs.tsx:83–98`, empty copy "No hay tareas vinculadas a este ticket")
- [x] 5.4 `TicketDetailPage/components/TicketSidebar.tsx` + `.module.css` — extract inline sidebar: status/priority badges, cliente link, asignado select, relative dates
- [x] 5.5 `src/pages/tickets/TicketDetailPage.tsx` + `.module.css` — header + grid 8/4 + TicketTabs + TicketSidebar; remove reply form; use CSS tokens (`--color-surface`, `--color-primary`, `--color-gray-200`, `--radius-xl`); avatar hsl tokens (mirror `TaskCommentsTimeline.module.css:94–95`)
- [x] 5.6 `TicketHeader.tsx` line 106 — `#{ticket.id}` → `#{ticket.sequenceNumber}`
- [x] 5.7 [GREEN] run FE tests → all green; `TicketDetailPage.test.tsx` — update: tabs render, description pre-wrap, "Sin descripción", replies removed

## Phase 6 — Orchestrator Gates

- [ ] 6.1 BE: `jest --runInBand` full suite green; no regressions in existing ticket/scheduling tests
- [ ] 6.2 FE: `vitest` full suite green; no regressions
- [ ] 6.3 Manual smoke: POST comment with image paste → 201 → thumbnail → lightbox; 413 on >8mb body; 422 on >2MB image; `/replies` returns 404
- [ ] 6.4 `GET /api/tickets/:id` response includes `tasks[]`
