# Tasks: Tickets List Redesign (#46)

> Wire contract (VERBATIM): PATCH /:id `{assigneeId}` · PATCH /:id/status `{status: nombre catálogo, validado vs TicketStatusCatalog → 422 TICKET_STATUS_NOT_FOUND}` · DELETE /:id soft-close · GET /?status= filtra SIEMPRE.

## Phase 1: BE Foundation — TDD RED

- [x] 1.1 [RED] `src/__tests__/tickets.routes.test.ts` + `__tests__/infrastructure/tickets.routes.new.test.ts`: agregar `InMemoryTicketStatusRepository` seedeado; añadir casos fallando: PATCH custom 200 + nombre canónico, 'cerrado'→"Cerrado" 200, desconocido 422 `TICKET_STATUS_NOT_FOUND`, faltante 400 `VALIDATION_ERROR`, legacy seed 200.
- [x] 1.2 [RED] `__tests__/infrastructure/tickets.tasks.routes.test.ts`: mismo seed + casos GET — status custom filtra, inexistente devuelve `[]`, sin `status` sin filtro.

## Phase 2: BE Core — TDD GREEN

- [x] 2.1 [GREEN] `tickets.routes.ts` L59: borrar `VALID_STATUSES` y sus dos usos (ambas ramas mueren aquí).
- [x] 2.2 [GREEN] `tickets.routes.ts`: actualizar firma `createTicketsRouter` — añadir `ticketStatusRepo: TicketStatusRepository` como param REQUIRED (compile-break en 4 call sites).
- [x] 2.3 [GREEN] `tickets.routes.ts` PATCH `/:id/status` (L131): lookup `ticketStatusRepo.getByName(status)` case-insensitive; si no existe → 422 `TICKET_STATUS_NOT_FOUND`; persistir `catalogEntry.name` (AD-3).
- [x] 2.4 [GREEN] `tickets.routes.ts` GET `/` (L100): pasar `status` al repo sin validación previa (AD-5, pass-through).
- [x] 2.5 [GREEN] `src/infrastructure/http/app.ts`: pasar `ticketStatusRepo` (ya instanciado) en los 4 call sites de `createTicketsRouter`.
- [x] 2.6 `npm test -- --runInBand` verde antes de continuar al FE.

## Phase 3: FE Foundation — Utilidad + API cleanup

- [x] 3.1 `src/utils/mapWithConcurrency.ts` (FE): worker-pool puro, firma `<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<{ results: R[], failedItems: T[] }>`.
- [x] 3.2 `src/api/tickets.api.ts`: eliminar `closeTicket` (muerta, 0 callers — AD-1).
- [x] 3.3 [RED] vitest wire-boundary: verificar método/URL/payload exactos por acción; NUNCA `/close`.

## Phase 4: FE TicketFilterDisclosure — TDD RED → GREEN

- [x] 4.1 [RED] Test disclosure: cerrado por defecto, badge count con 2 filtros activos, chips visibles afuera del panel, quitar chip no abre panel.
- [x] 4.2 `src/pages/tickets/TicketsListPage/components/TicketFilterBar.tsx`: exportar `ActiveFilterChips` (hoy privado L154).
- [x] 4.3 [GREEN] `TicketFilterDisclosure.tsx` + `.module.css`: botón "Filtros" + badge count + panel `max-height`/`opacity` 200ms ease-out + `TicketFilterBar` dentro + `ActiveFilterChips` renderizados afuera (AD-8). Tokens: `--space-*`, `--radius-md`, `--color-border/surface`.

## Phase 5: FE TicketsTableView + BulkActionBar — TDD RED → GREEN

- [x] 5.1 [RED] Test bulk: 2/5 fallan → toast "2 de 5 fallaron" + `setSelectedIds(failedIds)`; éxito total → toast + selección vacía.
- [x] 5.2 [RED] Test permisos: sin `tickets.delete` no aparece Eliminar; Cerrar usa nombre closed del catálogo vía CLOSED_SLUGS.
- [x] 5.3 [GREEN] `TicketsTableView.tsx` + `.module.css`: DataTable `selectable`, estados loading/empty diferenciado (sin tickets vs. sin resultados + "Limpiar filtros"). Tokens de header/toolbar espejo SchedulingTasksPage.
- [x] 5.4 [GREEN] `BulkActionBar` inline en `TicketsTableView`: 4 acciones Can-gateadas (Asignar, Cambiar estado, Cerrar, Eliminar). `mapWithConcurrency(ids, 5, fn)` via `mutateAsync` de hooks existentes (`useAssignTicket`, `useUpdateTicketStatus`, `useDeleteTicket`). Fallo parcial: toast conteo + `setSelectedIds(failedIds)`. Éxito: toast + vaciar. Confirm de Eliminar aclara soft-close (AD-6).

## Phase 6: FE Wiring + Orchestrator Gates

- [x] 6.1 `TicketsListPage.tsx`: delegar tabla/selección a `TicketsTableView`; montar `TicketFilterDisclosure`; header modernizado (tokens, densidad espejo SchedulingTasksPage).
- [x] 6.2 `vitest` completo verde (wire-boundary + bulk + permisos + disclosure).
- [ ] 6.3 Gate orquestador: confirmar branch FE desde `main` post-#44; confirmar BE PRs independientes y revertibles; confirmar orden deploy BE → FE.
