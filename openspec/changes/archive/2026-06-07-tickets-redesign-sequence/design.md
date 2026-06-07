# Design — tickets-redesign-sequence (#11)

BE (sequenceNumber) + FE (rediseño de la LISTA espejando tareas).

## Backend

### Modelo + migración (replica exacta del patrón de ScheduledTask)
- `prisma/schema.prisma`: `Ticket` += `sequenceNumber Int @unique @default(autoincrement())`.
- `domain/entities/ticket.ts`: `Ticket` += `sequenceNumber: number`. `CreateTicketInput` lo omite (lo asigna la DB).
- Migración `<ts>_add_ticket_sequence_number/migration.sql` — copia de `20260514100000_add_task_sequence_number` adaptada a `Ticket`:
  1. `ADD COLUMN "sequenceNumber" INTEGER;` (nullable para backfill)
  2. backfill `ROW_NUMBER() OVER (ORDER BY "createdAt", id)`
  3. `CREATE SEQUENCE "Ticket_sequenceNumber_seq" OWNED BY "Ticket"."sequenceNumber";`
  4. `setval(... MAX ... )`
  5. `ALTER COLUMN ... SET DEFAULT nextval(...), SET NOT NULL`
  6. `CREATE UNIQUE INDEX "Ticket_sequenceNumber_key"`
  Aditiva + idempotente en efecto. **Mostrar el SQL al usuario antes de pushear.**
- `PrismaTicketRepository`: el mapeo a entidad incluye `sequenceNumber`; `createTicket` NO lo setea (default DB). DTO/respuesta de ticket lo expone.
- `InMemoryTicketRepository` (tests): asignar `sequenceNumber` incremental al crear (contador), para paridad con el contrato.

### A verificar en apply
- Nombre exacto del repo in-memory de tickets + cómo crea (para el contador).
- El DTO/serialización del ticket (¿entidad directa como tasks, o un mapper?) — exponer `sequenceNumber`.

## Frontend (solo la lista)

### Layout — espejar `SchedulingTasksPage`
- `TicketsListPage.tsx`: reestructurar a single-column: `header → <TicketFilterBar horizontal> → tabla full-width`. **Eliminar** el 2-col actual (tabla izq + `filterAside` 280px derecha).
- `TicketsListPage.module.css`: alinear con `SchedulingTasksPage.module.css` (page/header/tableSection; quitar `filterAside`).
- `TicketFilterBar.tsx`: usar la variante **horizontal** por default (ya existe) + chips de filtros activos + "Limpiar todo", como `TaskFilterBar`.
- Tabla (column catalog de tickets): columna ID → `#${sequenceNumber}` linkeado al detalle; **prioridad como pill** color-coded (reusar el patrón/clases de `TasksTableView`); mantener `ColumnSelector` (ya importado).
- `src/types/ticket.ts`: `Ticket` += `sequenceNumber: number`. El hook de tickets ya trae el ticket → solo el tipo + el render.

### Estética
- Reusar tokens/estilos de tareas (priority pills, idLink/titleLink, tableSection) para que quede "como las tareas".

## Tests (TDD donde aplica)
- **BE**: el repo (in-memory) asigna `sequenceNumber` creciente; el DTO lo expone. (Si hay test de PrismaTicketRepository, no se toca la DB — el in-memory cubre el contrato.)
- **FE**: la lista renderiza `#${sequenceNumber}` linkeado; la prioridad se renderiza como pill; los filtros están en barra horizontal (no en aside). Tests de estructura/comportamiento (Vitest + testing-library).
- **Visual**: el "lindo/moderno" se valida con **Playwright** contra la app real tras el deploy (no es testeable por unit).

## Riesgos
- Rediseño FE grande → el grueso es CSS/layout; el riesgo de romper comportamiento existente (filtros, columnas) se cubre con los tests de TicketsListPage/TicketFilterBar existentes (ajustarlos al nuevo layout).
- Migración aditiva + backfill → segura; revisar SQL antes de pushear.
- `sequenceNumber` es solo display — el routing del ticket sigue por `id` (no cambia).
