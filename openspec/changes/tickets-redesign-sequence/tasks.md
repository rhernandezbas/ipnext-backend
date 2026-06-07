# Tasks — tickets-redesign-sequence (#11)

Strict TDD donde aplica (BE contrato; FE estructura). La estética se valida con Playwright. Solo la LISTA.

## Backend (ipnext-backend)

- [ ] **1. Modelo + entidad** — `Ticket` += `sequenceNumber Int @unique @default(autoincrement())` (schema); `domain/entities/ticket.ts` += `sequenceNumber: number`; `CreateTicketInput` lo omite. `tsc` verde.

- [ ] **2. RED+GREEN — repos exponen `sequenceNumber`**
  - `InMemoryTicketRepository`: asigna `sequenceNumber` incremental al crear (contador monotónico). `PrismaTicketRepository`: el mapeo a entidad incluye `sequenceNumber`.
  - Test: crear 2 tickets in-memory → `sequenceNumber` 1 y 2 crecientes; el DTO/respuesta lo expone.

- [ ] **3. Migración** — `prisma/migrations/<ts>_add_ticket_sequence_number/migration.sql`: copia de los 6 pasos de `20260514100000_add_task_sequence_number` adaptada a `Ticket` (ADD COLUMN nullable → backfill `ROW_NUMBER() OVER (ORDER BY createdAt,id)` → CREATE SEQUENCE OWNED → setval MAX → SET DEFAULT nextval + NOT NULL → UNIQUE INDEX). **Mostrar el SQL al usuario antes de pushear.**

- [ ] **4. Verify BE** — `tsc` (0) + `npx jest --runInBand` (verde). Commit + deploy (OK) + confirmar run en `gh` (incluido el step de migraciones).

## Frontend (ipnext-frontend)

- [ ] **5. Tipo** — `src/types/ticket.ts` += `sequenceNumber: number`.

- [ ] **6. RED+GREEN — lista espeja tareas** (`TicketsListPage` + su test)
  - Layout single-column (quitar el 2-col / `filterAside`); column ID → `#${sequenceNumber}` linkeado; prioridad como **pill** (reusar el patrón de `TasksTableView`).
  - Test: la lista renderiza `#N` linkeado; la prioridad sale como pill; no existe el panel lateral (filtros en barra horizontal).

- [ ] **7. `TicketFilterBar` horizontal** — variante horizontal por default + chips de filtros activos + "Limpiar todo", como `TaskFilterBar`. Ajustar el test del filter bar al nuevo layout.

- [ ] **8. Verify FE** — `tsc` (0) + `npx vitest run` (verde). Commit + deploy (OK) + `gh`. **Playwright** contra la app real para validar el look "como las tareas" (limpiar datos de prueba).

## Cierre

- [ ] **9. Archive + docs** — `sdd-archive` (mover change a `archive/`). Commit del `BACKLOG.md`: #11 → hecho (+ #23, #24 que viajan local).
