# Proposal: Ticket Detail Redesign + Persisted Comments with Images (#44)

## Intent

El detalle de ticket es pobre: la `description` NUNCA se renderiza, las replies viven in-memory (`ticketRepliesStore`, AD-6 — se pierden en cada deploy) y no hay adjuntos. Rediseñar `/admin/tickets/:id` al patrón de SchedulingTaskDetailPage (impeccable) y persistir la conversación con upload/paste de imágenes.

## Scope

### In Scope
- BE: `TicketComment` + `TicketCommentAttachment` en DB (espejo de TaskComment), migración aditiva, 3 use-cases (Add/List/Delete), ports + adapters Prisma/InMemory, ruta `GET/POST/DELETE /api/tickets/:id/comments` — STRICT TDD.
- Eliminar `ticketRepliesStore` y rutas `/:id/replies` (único consumer es el FE que se reescribe acá; pérdida de datos = cero, ya son efímeras).
- Storage: **base64 data-URI en `attachment.url`** (container sin volumen). Límites validados en AMBAS capas (zod en BE): ≤2MB/imagen post-encode, máx 3/comentario, solo `image/*`.
- Body parser scoped: `app.ts:581` usa `express.json()` → **default 100kb**; el router de comments necesita `express.json({ limit: '8mb' })` propio.
- FE: tabs (Descripción | Conversación | Relacionado), description prominente, sidebar mejorada, `#sequenceNumber` en header, TicketCommentsTimeline (fork de TaskCommentsTimeline) con paste clipboard + file input + previews + lightbox.
- Fix type lie `ticket.id: number` → `string` (mismo fix que #42).
- Permisos: GET `tickets.read`; POST/DELETE `tickets.write` (claves verificadas en TicketHeader.tsx).

### Out of Scope
- Notificaciones; edición/borrado de comentarios desde UI; upload real en tareas; storage en volumen/S3 (migración futura: `url` admite `data:` o `https:` sin breaking).

## Capabilities

### New Capabilities
- `ticket-comments`: conversación persistida del ticket con adjuntos de imagen inline (BE contract + límites).
- `ticket-detail-ui`: layout del detalle (tabs, description, sidebar, composer con paste/upload). No existe spec previa de tickets UI.

### Modified Capabilities
- None (no hay spec `tickets` existente; `ticket-status-catalog` no cambia).

## Approach

Espejo verbatim del patrón TaskComment (commit `536707dc`) en hexagonal estricto; FE espejo del hermano mayor #41.

**Wire contract** — `GET/POST /api/tickets/:id/comments`:
- comment: `{ id, ticketId, authorId, authorName, body, attachments[], createdAt }`
- attachment: `{ id, url ("data:image/...;base64,..."), filename, mimeType, sizeBytes }`
- Errores: `413 PAYLOAD_TOO_LARGE` (imagen >2MB o body >8MB), `422 VALIDATION_ERROR` (mime no-imagen, >3 adjuntos, body vacío), `404 NOT_FOUND` (ticket inexistente).

## Affected Areas

| Area | Impact |
|------|--------|
| `prisma/schema.prisma` + migration | New (aditiva, sin BEGIN/COMMIT) |
| `src/domain`, `src/application`, `src/infrastructure` (ticket-comments) | New |
| `tickets.routes.ts` | Modified (remove replies) |
| FE `TicketDetailPage*`, `useTickets.ts`, `types/ticket.ts` | Modified |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Body limit 100kb rompe POST con imágenes | High | json parser scoped 8mb en el router |
| Base64 hincha DB | Med | 2MB×3 máx; migración futura a URL documentada |
| Romper API en prod al borrar `/replies` | Low | único consumer es el FE reescrito en este change |

## Rollback Plan

Revert del deploy (FE+BE juntos). La migración es aditiva — las tablas nuevas quedan huérfanas sin afectar nada; drop opcional posterior.

## Dependencies

- Ninguna externa. Deploy coordinado FE+BE (el FE nuevo consume `/comments`).

## Success Criteria

- [ ] Comentario con imagen pegada del clipboard sobrevive un redeploy.
- [ ] `description` visible y prominente en el detalle.
- [ ] Imagen de 3MB rechazada en FE y BE (413/422).
- [ ] Rutas `/replies` eliminadas; suite verde (TDD).
