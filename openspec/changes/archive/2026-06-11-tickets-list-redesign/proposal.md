# Proposal: Tickets List Redesign (#46)

## Intent

`/admin/tickets/opened` quedó atrás respecto de la lista de tareas: sin acciones masivas, filtros siempre visibles ocupando espacio, layout menos moderno. Alinearla con el patrón de tareas (#41). Incluye fix BE: la whitelist `VALID_STATUSES` hardcodeada rompe statuses custom del catálogo (lección #27).

## Scope

### In Scope
- **FE**: `TicketsTableView` extraído de `TicketsListPage` (patrón `TasksTableView`), DataTable `selectable` + `BulkActionBar` clon de tareas.
- **FE bulk V1** (N requests con `mapWithConcurrency(5)`, toast con conteo de fallas, selección conservada en fallo parcial): Asignar · Cambiar estado (catálogo) · Cerrar · Eliminar (confirm). Cada acción gateada por `Can` (`tickets.write`/`close`/`delete`).
- **FE filtros**: `TicketFilterDisclosure` — botón "Filtros" con badge de count, panel colapsable (`useState` + CSS transition), `TicketFilterBar` reusado adentro. ActiveFilterChips SIEMPRE visibles fuera del panel.
- **FE**: API fns faltantes: `updateTicketStatus`, `deleteTicket` (no existen en main post-#44).
- **BE fix whitelist** (`tickets.routes.ts:59`): usada en DOS rutas — `PATCH /:id/status` (L147: 400 a statuses custom, ej. "Resuelto") y `GET /` (L112: dropea el filtro en silencio → tab custom devuelve lista SIN filtrar, bug latente hoy). Reemplazar por lookup a `TicketStatusRepository.getByName()` (inyectar el port al router).
- **BE**: agregar `POST /tickets/:id/close` (reusa `CloseTicket`). **Verificado: NO existe en BE en ninguna branch**, pero FE #44 (PR #82) ya lo llama — gap real de wire contract.
- Modernización visual alineada a tareas (header, density); pills #26 intactas.

### Out of Scope
- Endpoints bulk BE reales (`POST /tickets/bulk/*`) · Archive page (`GET /tickets/archive` ni existe en BE) · Columnas nuevas · Hard-delete real (hoy `DELETE /:id` = soft-close) · `requirePermission` BE en rutas de tickets.

## Capabilities

### New Capabilities
- `tickets-list-ui`: lista de tickets con selección, bulk actions V1, filtros colapsables con chips persistentes, y wire de cierre `POST /:id/close`.

### Modified Capabilities
- `ticket-status-catalog`: el catálogo pasa a ser la fuente de validación de status en rutas de tickets (PATCH /:id/status y filtro de lista) — muere la whitelist.

## Approach

Base: main post-#44 (`Ticket.id: string`). FE clona el patrón bulk de tareas; sin dependencias nuevas (no Radix). BE: cambio quirúrgico en `tickets.routes.ts` + wiring en `app.ts:980`. STRICT TDD ambos lados.

### Wire contract bulk (verificado en BE main)

| Acción | Endpoint | Permiso | Estado BE |
|--------|----------|---------|-----------|
| Asignar | `PATCH /tickets/:id` `{assigneeId}` | `tickets.write` | Existe |
| Cambiar estado | `PATCH /tickets/:id/status` `{status}` | `tickets.write` | Existe; fix whitelist |
| Cerrar | `POST /tickets/:id/close` | `tickets.close` | **CREAR** (FE #44 ya lo llama) |
| Eliminar | `DELETE /tickets/:id` | `tickets.delete` | Existe (soft-close) |

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| BE `src/infrastructure/http/routes/tickets.routes.ts` | Modified | Whitelist → catálogo; ruta `POST /:id/close` |
| BE `src/infrastructure/http/app.ts` | Modified | Inyectar `ticketStatusRepo` al router |
| FE `src/pages/tickets/TicketsListPage*` | Modified | TableView + disclosure + estilos |
| FE `src/hooks/useTickets.ts`, `src/api/tickets.api.ts` | Modified | Hooks bulk + API fns faltantes |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| #44 no mergeado al arrancar (`id: number`) | Med | Gate: verificar merge de PR #82 antes de abrir branch |
| "Eliminar" y "Cerrar" hacen lo mismo en BE (soft-close) | High (confuso) | Copy del confirm lo aclara; hard-delete queda OUT explícito |
| Selecciones grandes lentas (N requests) | Low | `mapWithConcurrency(5)`; toast con progreso/fallas |
| Status filter pass-through cambia semántica de GET / | Low | Status inexistente → lista vacía (más correcto que ignorar); cubierto por tests |

## Rollback Plan

FE y BE en PRs revertibles de forma independiente; el fix de whitelist no migra datos. `git revert` del merge alcanza. La ruta `/close` nueva es aditiva.

## Dependencies

- PR #82 (#44) mergeado en FE main — `Ticket.id: string`.
- Catálogo `TicketStatusCatalog` seedeado (ya en prod).

## Success Criteria

- [ ] Bulk asignar/estado/cerrar/eliminar sobre N tickets con conteo de fallas y selección conservada en fallo parcial.
- [ ] Status custom del catálogo aceptado en `PATCH /:id/status` y filtrable en la lista (sin whitelist).
- [ ] `POST /tickets/:id/close` operativo (desbloquea FE #44).
- [ ] Filtros colapsados por defecto; chips activos visibles siempre; permisos `Can` por acción.
