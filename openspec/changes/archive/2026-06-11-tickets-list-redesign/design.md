# Design: Tickets List Redesign (#46)

## Technical Approach

BE: cambio quirúrgico en `tickets.routes.ts` — muere `VALID_STATUSES` (L59) en sus dos usos (GET `/` L100, PATCH `/:id/status` L135), validando contra `TicketStatusRepository.getByName()` (el port YA tiene el método; case-insensitive en Prisma e InMemory). FE: extraer `TicketsTableView` de `TicketsListPage` (patrón `TasksTableView`), `BulkActionBar` inline, `TicketFilterDisclosure` nuevo. **NO se crea `POST /:id/close`** — corrección verificada: `closeTicket` (tickets.api.ts:111) es código muerto con cero callers; el cierre real del detalle usa `useUpdateTicketStatus` + CLOSED_SLUGS.

## Architecture Decisions

| # | Decisión | Alternativa rechazada | Rationale |
|---|----------|----------------------|-----------|
| AD-1 | No crear `POST /:id/close`; borrar `closeTicket` muerto | Crear la ruta (proposal original) | Cero callers verificado; el cierre real es PATCH /:id/status con nombre del catálogo — la ruta duplicaría semántica |
| AD-2 | `ticketStatusRepo: TicketStatusRepository` como param REQUIRED de `createTicketsRouter` (tras `closeTicket`, antes de `authProvider`) | Param opcional con fallback a whitelist | El fallback mantendría vivo el bug; el compile-break fuerza actualizar los 4 call sites |
| AD-3 | PATCH persiste el nombre canónico del catálogo (`catalogEntry.name`) | Persistir el input crudo | Pills/tabs matchean por nombre del catálogo; evita drift de mayúsculas ('cerrado' → "Cerrado") |
| AD-4 | 422 `TICKET_STATUS_NOT_FOUND` para status desconocido; 400 `VALIDATION_ERROR` para faltante | 400 para ambos | Distingue input malformado de referencia inexistente (patrón `REFERENCE_TO_CODE`) |
| AD-5 | GET `/` pass-through sin lookup al catálogo | Validar también en GET | Status inexistente → lista vacía natural del repo; un repo-call menos por listado |
| AD-6 | `BulkActionBar` fork inline en `TicketsTableView` (NO compartido con tareas) | Extraer componente común | Acciones, permisos y pickers distintos; DRY prematuro entre dominios |
| AD-7 | Bulk reusa hooks existentes vía `mutateAsync` (`useAssignTicket`, `useUpdateTicketStatus`, `useDeleteTicket`) + nuevo `src/utils/mapWithConcurrency.ts` (copia pura del BE) | Nuevas api fns en tickets.api.ts | Los hooks ya traen invalidaciones de `['tickets']`; el FE no tiene mapWithConcurrency hoy |
| AD-8 | Disclosure con `useState` + transición `max-height`/`opacity`; `ActiveFilterChips` se EXPORTA de `TicketFilterBar` y se renderiza fuera del panel | Radix Collapsible | Sin deps nuevas; los chips hoy son función privada (TicketFilterBar.tsx:154) — el export es necesario; variant `vertical` intacto |

## Data Flow (bulk)

```
selección → BulkActionBar → confirm/picker
  → mapWithConcurrency(ids, 5, fn con catch por id) → { failedIds }
  → failedIds.length ? toast "X de N fallaron" + setSelectedIds(failedIds)
                     : toast éxito + setSelectedIds([])
  → invalidación ['tickets'] (la traen los hooks)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| BE `src/infrastructure/http/routes/tickets.routes.ts` | Modify | Borrar whitelist L59; PATCH /:id/status (L131): lookup catálogo, canonical name, 422; GET / (L100): pass-through; nueva firma |
| BE `src/infrastructure/http/app.ts` | Modify | Pasar `ticketStatusRepo` (ya instanciado L816) en `createTicketsRouter` (L1017) |
| BE `src/__tests__/tickets.routes.test.ts`, `__tests__/infrastructure/tickets.routes.new.test.ts`, `__tests__/infrastructure/tickets.tasks.routes.test.ts` | Modify | Nuevo param con `InMemoryTicketStatusRepository` seedeado + casos TDD nuevos |
| FE `src/pages/tickets/TicketsListPage.tsx` | Modify | Delega tabla/selección a TicketsTableView; header modernizado |
| FE `.../TicketsListPage/components/TicketsTableView.tsx` (+ .module.css) | Create | DataTable `selectable` + BulkActionBar inline + estados empty/loading |
| FE `.../components/TicketFilterDisclosure.tsx` (+ .module.css) | Create | Botón "Filtros" + badge count + panel colapsable envolviendo TicketFilterBar; chips afuera |
| FE `.../components/TicketFilterBar.tsx` | Modify | `export` de ActiveFilterChips; variant vertical intacto |
| FE `src/utils/mapWithConcurrency.ts` | Create | Worker-pool puro, copia del BE |
| FE `src/api/tickets.api.ts` | Modify | DELETE `closeTicket` (muerto, 0 callers) |

## Wire Contract (VERBATIM — fuente: spec tickets-list-ui)

| Acción | Request | Body | Permiso |
|--------|---------|------|---------|
| Asignar | `PATCH /api/tickets/:id` | `{ assigneeId: string \| null }` | `tickets.write` |
| Cambiar estado | `PATCH /api/tickets/:id/status` | `{ status: <nombre del catálogo> }` | `tickets.write` |
| Cerrar | `PATCH /api/tickets/:id/status` | `{ status: <nombre closed del catálogo vía CLOSED_SLUGS ['cerrado','closed'], fallback 'cerrado'> }` | `tickets.write` |
| Eliminar | `DELETE /api/tickets/:id` (BE = soft-close; el copy del confirm lo aclara) | — | `tickets.delete` |

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| BE routes (Jest+supertest, STRICT TDD) | PATCH: custom 200 + canonical; 'cerrado'→"Cerrado" 200; desconocido 422; faltante 400; legacy seeds 200. GET: custom filtra; inexistente `[]`; sin status sin filtro | Router con `InMemoryTicketStatusRepository` seedeado |
| FE wire boundary (vitest) | Método/URL/payload exactos por acción; NUNCA `/close` | Mock de `axios-client` |
| FE bulk | 2/5 fallan → toast conteo + selección=fallidos; éxito total limpia | Mock de hooks/axios con rechazos selectivos |
| FE permisos | Botones gateados por acción | Mock de `useMyPermissions`/`useCan` |
| FE disclosure | Cerrado default, badge count, chips visibles afuera, quitar chip sin abrir | Testing Library |

## Tokens / Impeccable (register: product, sistema HSL — página estándar)

Tokens globales de `src/tokens/variables.css`: `--space-*`, `--radius-md/lg`, `--transition-fast/normal`, `--color-border/surface/primary`. BulkActionBar = panel inline sobre la tabla (patrón tareas): full border 1px `--color-border`, `--radius-md`, fondo `--color-surface` — NADA de side-stripes ni gradientes. Panel de filtros: `max-height` + `opacity` 200ms ease-out. Pills #26 intactas. Densidad de header/toolbar espejo de SchedulingTasksPage. Empty states con copy diferenciado y acción "Limpiar filtros".

## Migration / Rollout

Sin migración de datos. PRs FE/BE independientes y revertibles. **Orden: BE primero** — el bulk "Cambiar estado"/"Cerrar" con statuses custom depende del fix de whitelist (y el cierre del detalle ya está roto hoy con catálogo en español).

## Open Questions

Ninguna bloqueante.
