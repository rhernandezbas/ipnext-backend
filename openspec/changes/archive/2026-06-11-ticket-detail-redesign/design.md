# Design: Ticket Detail Redesign + Persisted Comments (#44)

Verificado contra `origin/main` de ambos repos (BE `65924682`, FE `24fbf66`).

## Technical Approach

BE: espejo del patrón `TaskComment` (schema `prisma/schema.prisma:1332-1355`, migración `20260527110000_add_task_comments`) en hexagonal estricto: entidad → port → use cases → adapters Prisma/InMemory → router nuevo montado en `/api/tickets`. FE: fork de `TaskCommentsTimeline` (#41) con paste/upload base64, tabs con la molecule `Tabs` existente, y fix del type lie `ticket.id: number`.

## Architecture Decisions

| # | Decisión | Alternativa rechazada | Rationale |
|---|----------|----------------------|-----------|
| D1 | **Schema espejo EXACTO**: `authorName String` denormalizado, **sin** `authorId` FK | Spec actual: `authorId FK→RbacUser SetNull` + authorName resuelto al leer | El precedente (`schema.prisma:1332-1343`) no tiene authorId; `ListTaskComments` no hace join. El `authorId` de replies era un `1` hardcodeado (`useTickets.ts:72`). **⚠ requiere amend del spec** (ver Open Questions) |
| D2 | **authorName se resuelve en el FE al escribir** (`resolveAuthorName`: displayName→username→email, `TaskCommentsTimeline.tsx:24-31`), viaja en el POST body; BE fallback `req.user?.username` | Join a RbacUser en cada GET | Espejo del precedente exacto; cero acoplamiento del use case a RbacUser |
| D3 | **Parser path-scoped ANTES del global** en `app.ts` (hoy línea 603) | `router.use(express.json({limit:'8mb'}))` dentro del router | El global `app.use(express.json())` corre antes que TODOS los routers (montados ~línea 997+): un parser a nivel router **nunca ve el body crudo** — el global ya lo rechazó con 413 a los 100kb. body-parser saltea el segundo parse (`req._body`), así que el doble registro es seguro |
| D4 | **413 SOLO para body>8mb** (error `entity.too.large` del parser, mapeado en `errorHandler`); **imagen>2MB → 422** junto con el resto de zod | Proposal: imagen>2MB → 413 | El parser solo puede detectar el límite transport-level; la imagen individual es validación de aplicación. El spec ya lo pide así (scenario "imagen >2MB → 422") |
| D5 | **Sin DELETE en V1**: port mínimo `listByTicket` + `create`; use cases solo `ListTicketComments` + `AddTicketComment` | Espejo completo con `DeleteTicketComment` (proposal lo mencionaba) | El spec no tiene requirement DELETE y el borrado desde UI está out-of-scope en el proposal. YAGNI: sin consumer, el delete es código muerto. El fork del FE **quita** el botón "×" del CommentItem |
| D6 | **Router nuevo** `ticketComments.routes.ts` montado en `/api/tickets` (espejo de `taskComments.routes.ts`) | Extender `createTicketsRouter` | tickets.routes no recibe `requirePerm` hoy (auth plano); inyectar perms ahí obliga a tocar su firma y sus 8 rutas. Sin riesgo de colisión: el tickets router no tiene catch-alls y `/:id` no captura `/:id/comments` (segmentos distintos) |
| D7 | **Relacionado: enriquecer `GET /tickets/:id` con `tasks[]`** (include aditivo en `PrismaTicketRepository.getById`) | Filtro `?ticketId` en `/api/scheduling` | NO existe filtro por ticketId en ListTasks/SchedulingRepository (verificado); el schema ya tiene la relación `Ticket.tasks ScheduledTask[]`. Campo opcional en la entidad → no rompe nada |
| D8 | **Fork, no extracción**: `Lightbox`/`AttachmentThumb`/`Composer` son componentes privados NO exportados dentro de `TaskCommentsTimeline.tsx` (líneas 82-167) | Extraer a `components/molecules/` | Precedente #41: TicketHeader ya fue clon, no share. Extraer ahora genera churn en scheduling durante applies paralelos. **Gotcha del fork**: `isImageUrl` (línea 18) es regex de extensión y NO matchea data-URIs → el fork necesita `url.startsWith('data:image/')` |
| D9 | 404 con ticket inexistente: ambos use cases reciben `TicketRepository` (port existente, `getById`) y tiran `TicketNotFoundError` (ya existe, `domain/errors/index.ts:18`, mapeado 404 en errorHandler) | Mirror del precedente (no valida existencia) | El spec exige 404 en GET y POST. Las rutas hacen try/catch + `next(err)` (el precedente taskComments no lo hace — gap latente que acá NO repetimos) |

## Wire Contract — VERBATIM (ambos applies)

```
GET  /api/tickets/:ticketId/comments          → 200 TicketComment[]   (createdAt ASC)
POST /api/tickets/:ticketId/comments          → 201 TicketComment

TicketComment = {
  id: string, ticketId: string, authorName: string, body: string,
  createdAt: string (ISO 8601),
  attachments: [{ id: string, commentId: string, url: string,
                  filename: string, mimeType: string | null, sizeBytes: number | null }]
}

POST request body = {
  body?: string,                       // default ""
  authorName?: string,                 // FE manda displayName→username→email; BE fallback req.user.username
  attachments?: [{ url: "data:image/…;base64,…", filename: string,
                   mimeType: "image/…", sizeBytes: number }]   // máx 3
}

Errores: 401 | 403 FORBIDDEN | 404 TICKET_NOT_FOUND
         422 VALIDATION_ERROR  (mime no-imagen, >3 adjuntos, data-URI malformado,
                                imagen>2MB decodificada, sizeBytes ≠ longitud real, body Y attachments vacíos)
         413 PAYLOAD_TOO_LARGE (JSON crudo > 8mb — entity.too.large)
SIN authorId en ningún lado (D1). SIN DELETE (D5).
```

## Data Flow

```
clipboard/file → onPaste/input → File → FileReader.readAsDataURL → chip preview (≤2MB, ≤3, image/*)
  → POST /api/tickets/:id/comments {body, authorName, attachments[data-URI]}
  → [json 8mb scoped] → auth → requirePerm(tickets,write) → zod 422/413 → AddTicketComment
  → TicketRepository.getById (404) → TicketCommentRepository.create → 201
  → invalidate ['ticket-comments', id] → timeline re-render → thumb data-URI → Lightbox
```

## Snippets no-obvios

**Parser scoped (app.ts, inmediatamente ANTES de `app.use(express.json())` — hoy línea 603):**
```ts
// #44 — las imágenes de comentarios de ticket viajan como data-URI base64; el default
// de 100kb las rechazaría. Límite SOLO para este path; debe registrarse ANTES del parser
// global (body-parser saltea el re-parse vía req._body).
app.use('/api/tickets/:ticketId/comments', express.json({ limit: '8mb' }));
app.use(express.json());
```

**errorHandler — rama 413 (antes del check DomainError, `middleware/errorHandler.ts:84`):**
```ts
if ((err as { type?: string })?.type === 'entity.too.large') {
  res.status(413).json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
  return;
}
```

**Zod (src/application/dto/ticketComments.dto.ts):**
```ts
const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const TicketCommentAttachmentSchema = z.object({
  url: z.string().regex(DATA_URI_RE), filename: z.string().min(1),
  mimeType: z.string().regex(/^image\//), sizeBytes: z.number().int().positive(),
}).superRefine((a, ctx) => {
  const m = DATA_URI_RE.exec(a.url); if (!m) return;
  const [, mime, b64] = m;
  const real = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (real > MAX_IMAGE_BYTES) ctx.addIssue({ code: 'custom', message: 'image exceeds 2MB' });
  if (real !== a.sizeBytes)   ctx.addIssue({ code: 'custom', message: 'sizeBytes mismatch' });
  if (a.mimeType !== mime)    ctx.addIssue({ code: 'custom', message: 'mimeType mismatch' });
});
export const AddTicketCommentSchema = z.object({
  body: z.string().default(''), authorName: z.string().min(1).optional(),
  attachments: z.array(TicketCommentAttachmentSchema).max(3).default([]),
}).refine(d => d.body.trim().length > 0 || d.attachments.length > 0);
```

**Paste handler (Composer del fork):**
```tsx
function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
  const files = Array.from(e.clipboardData?.files ?? []).filter(f => f.type.startsWith('image/'));
  if (files.length === 0) return;        // texto: dejarlo entrar al textarea
  e.preventDefault();
  void addFiles(files);                  // mismo camino que el <input type="file">
}
// addFiles: valida tipo/2MB/máx3 (mensajes del spec, aria-live="polite") → FileReader → draft chip
```

**Wiring (app.ts, junto a línea 1007; `ticketAdapter` ya existe ~línea 613):**
```ts
const ticketCommentRepo = new PrismaTicketCommentRepository();
app.use('/api/tickets', createTicketCommentsRouter(
  new ListTicketComments(ticketCommentRepo, ticketAdapter),
  new AddTicketComment(ticketCommentRepo, ticketAdapter),
  createAuthMiddleware(authAdapter, sessionRepo),
  { read: requirePerm('tickets', 'read'), write: requirePerm('tickets', 'write') },
));
```

## File Changes

### BE
| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | `TicketComment` + `TicketCommentAttachment` espejo de líneas 1332-1355 (taskId→ticketId, FK→`Ticket` cascade) |
| `prisma/migrations/20260628000000_add_ticket_comments/migration.sql` | Create | Espejo de `20260527110000_add_task_comments/migration.sql` (sin BEGIN/COMMIT, FK a `"Ticket"`) |
| `src/domain/entities/ticketComment.ts` | Create | Espejo de `taskComment.ts` |
| `src/domain/entities/ticket.ts` | Modify | `tasks?: Array<{id:string; sequenceNumber:number; title:string}>` (D7, opcional) |
| `src/domain/ports/TicketCommentRepository.ts` | Create | `listByTicket(ticketId)` + `create(comment)` (D5) |
| `src/application/dto/ticketComments.dto.ts` | Create | Zod (snippet) |
| `src/application/use-cases/ListTicketComments.ts` / `AddTicketComment.ts` | Create | Ambos con `TicketRepository` para el 404 (D9); Add sin recorder (tickets no tienen activity log) |
| `src/infrastructure/adapters/prisma/PrismaTicketCommentRepository.ts` | Create | Espejo de `PrismaTaskCommentRepository.ts` (orderBy createdAt asc, include attachments) |
| `src/infrastructure/adapters/in-memory/InMemoryTicketCommentRepository.ts` | Create | Paridad |
| `src/infrastructure/adapters/prisma/PrismaTicketRepository.ts` | Modify | `getById` include `tasks: { select: {id, sequenceNumber, title} }` |
| `src/infrastructure/http/routes/ticketComments.routes.ts` | Create | `createTicketCommentsRouter(list, add, auth, {read, write})`; try/catch + `next(err)` |
| `src/infrastructure/http/routes/tickets.routes.ts` | Modify | Eliminar `TicketReply`, `ticketRepliesStore`, `nextReplyId` (líneas 62-76) y rutas `/:id/replies` (285-320) |
| `src/infrastructure/http/app.ts` | Modify | Parser scoped (pre-603) + wiring (~1007) |
| `src/infrastructure/http/middleware/errorHandler.ts` | Modify | Rama `entity.too.large` → 413 |

### FE
| File | Action | Description |
|------|--------|-------------|
| `src/types/ticketComments.ts`, `src/api/ticketComments.api.ts`, `src/hooks/useTicketComments.ts` | Create | Espejo de taskComments (BASE `/tickets`, queryKey `['ticket-comments', id]`, invalida solo su key — sin activity feed) |
| `.../TicketDetailPage/components/TicketCommentsTimeline.tsx` + `.module.css` | Create | Fork: + paste/file-input/previews, `isImage` acepta data-URI, − botón delete, − "Adjuntar URL" |
| `.../TicketDetailPage/components/TicketTabs.tsx` + `.module.css` | Create | Tabs molecule: `conversacion` (default) \| `datos` \| `relacionado`; Datos = description `white-space: pre-wrap` / "Sin descripción"; Relacionado = patrón `RelacionadoPanel` (`TaskTabs.tsx:83-98`) sobre `ticket.tasks`, empty "No hay tareas vinculadas a este ticket" |
| `.../TicketDetailPage/components/TicketSidebar.tsx` + `.module.css` | Create | Extrae la sidebar inline: badges status/prioridad, cliente link, asignado select, fechas relativas |
| `src/pages/tickets/TicketDetailPage.tsx` + `.module.css` | Modify | Header + grid 8/4 + TicketTabs + TicketSidebar; muere el form de replies. CSS nuevo con tokens (`src/tokens/variables.css`: `--color-surface` #ffffff, `--color-primary` #0d6efd, `--color-gray-200` #dee2e6, `--radius-xl` 16px) — NO los hex crudos slate del css actual. Avatar: `hsl(var(--avatar-hue) 60% 92%)` / `50% 32%` (`TaskCommentsTimeline.module.css:94-95`) |
| `.../components/TicketHeader.tsx` | Modify | Línea 106: `#{ticket.id}` (¡hoy muestra el UUID!) → `#{ticket.sequenceNumber}` |
| `src/hooks/useTickets.ts` | Modify | Eliminar `useTicketReplies` (61-66) y `useAddTicketReply` (68-77) |
| **Fix `ticket.id: string`** — call sites verificados con rg | Modify | `types/ticket.ts:14` (id) + `:21` (customerId) + borrar `TicketReply` (58-66); `api/tickets.api.ts:96` (`createTaskFromTicket(ticketId: number→string)`) y `:103` (`updateTicket(id: number→string)`); `hooks/useScheduling.ts:80`; `types/scheduling.ts:53,161` (`ticketId?: number→string`); `CreateTaskModal.tsx:46`; `TaskTabs.tsx:27,85,97-98` (RelacionadoPanel); `__tests__/tickets/TicketDetailPage.test.tsx` (fixtures) |

## Testing Strategy (STRICT TDD — red→green→refactor)

| Layer | Test | Approach |
|-------|------|----------|
| BE unit | `__tests__/application/ticketComments.dto.test.ts` | Zod edges: data-URI ok / malformado / mime mismatch / >2MB decodificado / sizeBytes mismatch / 4 adjuntos / vacío total / solo-imagen ok |
| BE unit | `__tests__/application/TicketComments.test.ts` | Use cases con `InMemoryTicketCommentRepository` + `InMemoryTicketRepository`: list ASC, add roundtrip, `TicketNotFoundError` en ambos |
| BE seam | `__tests__/infrastructure/ticketComments.routes.test.ts` | supertest (router + in-memory + `errorHandler`, patrón `taskComments.routes.test.ts`): 200 [], 201, 404, 422×4, 403 (stub perms), **413**: mini-app con `express.json({limit:'1kb'})` + errorHandler → body 2kb |
| BE composition | `__tests__/infrastructure/ticket-comments-composition.test.ts` | Estático sobre fuente de app.ts (patrón `task-general-status-composition.test.ts`): (1) `indexOf` del parser scoped `'8mb'` < `indexOf('app.use(express.json())')`; (2) `createTicketCommentsRouter(` con `requirePerm('tickets','read'/'write')`; (3) ausencia de `ticketRepliesStore` y `/replies` |
| FE unit | `TicketCommentsTimeline.test.tsx` (vitest+RTL) | Paste: `fireEvent.paste(textarea, { clipboardData: { files: [new File([…],'s.png',{type:'image/png'})] } })` → chip (FileReader real de jsdom + waitFor); >2MB / 4ta / PDF → mensajes del spec; submit → payload shape (mock `ticketComments.api`) |
| FE perms | idem | mock `useMyPermissions`: sin `tickets.write` → composer oculto, timeline visible |
| FE wire | `ticketComments.api` boundary | mock axios-client: URLs `/tickets/:id/comments` + shape exacto del contrato |
| FE page | `TicketDetailPage.test.tsx` update | tabs, description pre-wrap, "Sin descripción", replies eliminadas |

## Migration / Rollout

Orden: **BE primero, FE inmediatamente después** (mismo release). Ventana FE-viejo/BE-nuevo: `GET /:id/replies` → 404 `NOT_FOUND` (catch-all app.ts) → `useTicketReplies` falla → la página renderiza "Sin respuestas aún." sin crash (`TicketDetailPage.tsx:115` usa `replies ?? []`); el POST de reply falla silencioso. **Aceptable**: los replies eran in-memory y morían con cada deploy igual — la ventana muestra exactamente el mismo estado que cualquier restart, pérdida de datos = cero. Migración aditiva; rollback = revert de ambos deploys, tablas quedan huérfanas inofensivas.

## Open Questions (para el orquestador — amendments de spec ANTES del apply)

- [ ] **`specs/ticket-comments/spec.md` contradice D1/D2**: tiene `authorId FK→RbacUser SetNull` + "Usuario eliminado" + `authorId` en el wire. Amend: espejo exacto (authorName denormalizado, `authorName?` en el request). La instrucción de diseño ("espejo EXACTO del precedente") manda.
- [ ] **Spec del parser**: dice "montar en este router" — técnicamente imposible (D3). Amend: "path-scoped antes del parser global".
- [ ] **DELETE**: proposal lo lista, spec no lo tiene, UI out-of-scope → V1 sin DELETE (D5). Confirmar.
