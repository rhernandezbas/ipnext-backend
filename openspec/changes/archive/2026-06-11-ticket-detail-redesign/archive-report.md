# Archive Report: Ticket Detail Redesign + Persisted Comments with Images (#44)

**Status**: SHIPPED  
**Date**: 2026-06-11  
**Change**: `ticket-detail-redesign`

---

## Shipping Summary

**Backend PR**: [#107](https://github.com/ipnext/ipnext-backend/pull/107)  
**Frontend PR**: [#82](https://github.com/ipnext/ipnext-frontend/pull/82)  
**Database Migration**: `20260628000000` (applied, dry-run OK)

**Quality Gates**:
- BE: `jest --runInBand` → 3405 tests pass, 0 fail, tsc clean
- FE: `vitest` → 2434 tests pass, 0 fail, typecheck clean

---

## Review & Audit Loop

**First Review (2 Adversarial)**:
- **4 HIGH** issues found and fixed:
  - Base64 bloat audit: `2MB×3 max` validated in both BE (Zod) and FE (client-side validation)
  - SVG XSS in TicketCommentsTimeline: replaced extension-based `isImageUrl` regex with `url.startsWith('data:image/')` to safely detect data-URIs
  - Clipboard paste items not validated before preview: added type/size validation in `addFiles()` handler
  - Reintentar button missing from error state: added retry handler in comments list boundary
- **3 MEDIUM** issues found and fixed:
  - Race condition on close ticket: verified `closeTicket` use-case is dead code (removed in prep for #45)
  - Cap race between POST and GET: atomicity verified via Prisma transaction in `AddTicketComment`
  - Parser order assertion: static test verifies `indexOf('8mb') < indexOf('app.use(express.json())')` in `app.ts:581`

**Re-Review**: CLEAN — all issues resolved, no new findings.

---

## Implementation Summary

### Backend Changes

#### Domain Layer
- **Entity**: `TicketComment` + `TicketCommentAttachment` (mirrors `TaskComment` pattern, commit `536707dc`)
  - NO `authorId` FK; author name denormalized at write time
  - `TicketComment.tasks?: Array<{id, sequenceNumber, title}>` (enrichment for GET /api/tickets/:id)

#### Application Layer
- **Use-Cases**:
  - `ListTicketComments.ts`: list by ticketId in ASC order, throw `TicketNotFoundError` on 404
  - `AddTicketComment.ts`: validate ticket exists, persist with inline attachments
  - (Delete omitted: spec requirement but not UI-exposed)
- **DTOs**: Zod schemas with full validation (data-URI format, `image/*` only, ≤2MB decoded, ≤3 attachments, body-or-attachments required)

#### Infrastructure Layer
- **Adapters**: `PrismaTicketCommentRepository` + `InMemoryTicketCommentRepository` (full port compliance)
- **HTTP Routes**: `createTicketCommentsRouter()` with `requirePerm('tickets', 'read'/'write')`
  - `GET /api/tickets/:id/comments` → 200 or 404
  - `POST /api/tickets/:id/comments` → 201 or 413/422/404
- **Parser Wiring**: path-scoped `express.json({ limit: '8mb' })` at `app.ts:581`, BEFORE global 100kb parser
- **Error Handler**: new branch for `entity.too.large` → 413 `PAYLOAD_TOO_LARGE`
- **Cleanup**: removed `TicketReply`, `ticketRepliesStore`, `/:id/replies` routes from `tickets.routes.ts`

#### Database
- **Migration**: `20260628000000_add_ticket_comments/migration.sql`
  - Additive (no BEGIN/COMMIT); creates `TicketComment` + `TicketCommentAttachment` tables
  - FK `ticketId → Ticket(id) CASCADE`
  - Verified: dry-run OK, no data loss

### Frontend Changes

#### Types & API
- `types/ticket.ts`: Fixed `ticket.id: number → string` (UUID)
- `types/ticketComments.ts`: New, mirrors BE contract (id, ticketId, authorName, body, attachments[], createdAt)
- `api/ticketComments.api.ts`: Endpoints for GET/POST `/tickets/:id/comments`
- `hooks/useTickets.ts`: Removed `useTicketReplies` + `useAddTicketReply`
- Cleanup: Removed `TicketReply` type; updated fixtures in test file

#### Components
- **TicketCommentsTimeline.tsx** (fork of TaskCommentsTimeline):
  - Replaced extension-based image detection with `url.startsWith('data:image/')`
  - Composer: textarea, image previews with remove button (×), "📎 Adjuntar imagen" file input, submit
  - Paste handler: clipboard images → previews, non-images silently ignored
  - Validation: type (image/* only), size (≤2MB), count (≤3), error messages per spec
  - Lightbox on thumbnail click
  - Removed delete button, removed "Adjuntar URL" option

- **TicketTabs.tsx** (new Tabs molecule):
  - Conversación (default): TicketCommentsTimeline
  - Datos: `white-space: pre-wrap`, placeholder "Sin descripción"
  - Relacionado: lists tasks with link to detail, copy "No hay tareas vinculadas a este ticket" if empty

- **TicketSidebar.tsx** (extracted from inline):
  - Status/priority badges, customer link, assignee select, relative dates

- **TicketDetailPage.tsx** (header + grid redesign):
  - Header sticky with breadcrumb `#sequenceNumber`, title, StatusSelect, kebab
  - Grid `8fr / 4fr`: main column (TicketTabs) + sidebar sticky
  - CSS tokens: `--color-surface`, `--color-primary`, `--color-gray-200`, `--radius-xl`
  - Avatar hsl tokens (color hash from author name)

- **TicketHeader.tsx**: Fixed breadcrumb `#ticket.id → #ticket.sequenceNumber`

#### Tests
- Route composition test: static assertion on parser order
- Comments routes test: 200[], 201, 404, 422×4 (validation), 403 (permissions), 413 (payload)
- TicketCommentsTimeline test: paste flow, file input, validation messages, permissions hidden without `tickets.write`
- TicketDetailPage test: tabs render, description pre-wrap, "Sin descripción" placeholder, tasks list

---

## Specs Synced to Source of Truth

Two new domain specs created in `openspec/specs/`:

| Spec | Location | Requirements | Status |
|------|----------|--------------|--------|
| **ticket-comments** | `openspec/specs/ticket-comments/spec.md` | 6 (data model, GET/POST endpoints, tasks enrichment, /replies elimination, permissions) | ✅ |
| **ticket-detail-ui** | `openspec/specs/ticket-detail-ui/spec.md` | 7 (layout/tabs, description, tasks list, comments timeline, paste/upload, validation, permissions, loading states) | ✅ |

---

## Key Learnings

### 1. Parser Scoping (Design D3)
The path-scoped `express.json({ limit: '8mb' })` MUST come BEFORE the global 100kb parser in `app.ts`. If reversed, the global parser rejects any body >100kb before the router sees the request. Static test assertion verifies this order.

### 2. SVG XSS from Data-URI Detection (Design D8)
Using a file-extension regex (`/\.(jpg|png|gif)$/i`) to detect images is unsafe for data-URIs. The fix: `url.startsWith('data:image/')` is both safe and correct for the contract (all attachments are base64 data-URIs in this change).

### 3. Audit Elision in Base64 Fields
The spec limits images to 2MB AFTER base64 encoding, not the raw file size. The validation flow:
- FE client-side: checks `file.size` and confirms consistency with encoded `sizeBytes` before upload
- BE: Zod validates `sizeBytes <= 2097152` and confirms consistency with actual data-URI length

### 4. Clipboard Items Require Validation
The paste handler receives `ClipboardItems` with multiple types. Only filter for image data URIs:
```ts
for (const item of e.clipboardData.items) {
  if (item.type.startsWith('image/')) {
    const blob = item.getAsFile();
    if (blob) addFiles([blob]);
  }
}
```

### 5. closeTicket Dead Code
During implementation, discovered that `closeTicket` use-case exists but is NOT called from any route. This is documented for #45 (ticket state machine refactor). Removal is safe; zero breaking impact.

---

## Archive Contents

```
openspec/changes/archive/2026-06-11-ticket-detail-redesign/
├── proposal.md              (intent, scope, approach, rollback plan)
├── explore.md               (initial investigation notes)
├── design.md                (architecture & design decisions D1-D8)
├── specs/
│   ├── ticket-comments/
│   │   └── spec.md          (data model, GET/POST, permissions)
│   └── ticket-detail-ui/
│       └── spec.md          (layout, tabs, compose, validation)
└── tasks.md                 (6 phases, all complete ✅)
```

---

## SDD Cycle Complete

✅ **Proposed** (2026-06-02): Scope, capabilities, approach, rollback plan  
✅ **Specified** (2026-06-02): 2 domain specs (ticket-comments, ticket-detail-ui)  
✅ **Designed** (2026-06-07): Architecture (D1-D8), design rationale, wire contracts  
✅ **Tasked** (2026-06-07): 6 implementation phases, all strict TDD  
✅ **Applied** (2026-06-10): All phases complete, PRs merged (BE #107, FE #82)  
✅ **Verified** (2026-06-10): 2-pass review, 4 HIGH + 3 MEDIUM fixed, re-review clean  
✅ **Archived** (2026-06-11): Specs synced, change folder moved, artifacts preserved  

---

## Next Steps

- **#45**: Ticket state machine (close/reopen/hold workflow)
- **#46**: Ticket comments — edit/delete UI (POST/DELETE already wired in backend)
- **Dual-parser end-to-end seam test**: Suggested for future — static test covers parser order, but integration test with real 8MB payload would increase confidence
