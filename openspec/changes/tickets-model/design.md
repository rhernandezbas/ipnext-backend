# Design — tickets-model

## Technical Approach

El cambio convierte los tickets en un agregado de dominio persistido, espejando 1:1 el patrón ya probado de `ScheduledTask`:

- FK `customerId String?` → `Client` con `onDelete: SetNull` y `@@index([customerId])` (idéntico a `ScheduledTask:570-571,598`).
- Mapper `toTicket(row)` en el adapter Prisma que deriva `customerName` del JOIN `customer: { select: { id, name } }` (idéntico a `toTask` en `PrismaSchedulingRepository:19-96,111-121`), sin texto libre.
- Filtro `customerId` en `list()` (`where['customerId'] = filter.customerId`), igual que `PrismaSchedulingRepository.listTasks:128`, expuesto en la route como `?customerId` igual que `scheduling.routes.ts:90`.

El contador del frontend NO necesita endpoint nuevo: el botón "Tareas (N)" ya cuenta haciendo `GET /api/scheduling?customerId=X` y usando el length/`total` del resultado. "Tickets (N)" hace lo mismo contra `GET /api/tickets?customerId=X`. **El backend solo debe garantizar el filtro y un `total` correcto.**

La parte no trivial no es el modelo — es **reemplazar el backing sin romper la superficie HTTP** que el frontend ya consume, y **resolver el drift de vocabulario de `status`** que hoy existe entre la entidad y la route.

## Estado actual (verificado en código)

| Pieza | Hoy | Archivo |
|-------|-----|---------|
| Entidad | `clientId: string` (texto libre), status `'abierto'\|'en_progreso'\|'cerrado'` | `domain/entities/ticket.ts` |
| Puerto | `list/getStats/create`, **sin `customerId`** | `domain/ports/TicketRepository.ts` |
| Adapter real | Splynx `/api/2.0/admin/support/ticket` (licencia vencida) | `adapters/splynx/SplynxTicketAdapter.ts` |
| Adapter in-memory | **NO existe** | — |
| Estado mutable | 5 `Map`/`Set` en la route + `shared-stores` | `tickets.routes.ts`, `shared-stores.ts` |
| Status en route | valida `'open'\|'pending'\|'resolved'\|'closed'` (¡distinto a la entidad!) | `tickets.routes.ts:113` |
| Modelo Prisma | **NO existe** (grep confirmado) | `prisma/schema.prisma` |
| Wiring | `new SplynxTicketAdapter(splynxClient)` | `app.ts:342,355-357,647` |

## Modelo Ticket propuesto

```prisma
enum TicketStatus {
  open
  pending
  closed
}

enum TicketPriority {
  low
  medium
  high
}

model Ticket {
  id          String         @id @default(uuid())
  subject     String
  description String

  status      TicketStatus   @default(open)
  priority    TicketPriority @default(medium)

  // FK al cliente — espejo de ScheduledTask.customerId
  customerId  String?
  customer    Client?        @relation(fields: [customerId], references: [id], onDelete: SetNull)

  // Asignación opcional a un Admin — espejo de ScheduledTask.assigneeId
  assigneeId  String?
  assignee    Admin?         @relation("TicketAssignee", fields: [assigneeId], references: [id], onDelete: SetNull)

  // Previsto para la futura integración de "casos" de Gestión Real (out-of-scope)
  grCasoId    String?        @unique

  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt

  @@index([customerId])
  @@index([status])
  @@index([assigneeId])
}
```

Back-relations a agregar:
- `Client`: `tickets Ticket[]` (junto a `tasks ScheduledTask[]` en `schema.prisma:194`).
- `Admin`: `assignedTickets Ticket[] @relation("TicketAssignee")`.

Entidad de dominio resultante (`domain/entities/ticket.ts`):

```ts
export type TicketPriority = 'low' | 'medium' | 'high';
export type TicketStatus   = 'open' | 'pending' | 'closed';

export interface Ticket {
  id: string;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  customerId: string | null;
  customerName: string | null;   // JOIN-derived (Client.name) — NO texto libre
  assigneeId: string | null;
  assigneeName: string | null;   // JOIN-derived (Admin.name)
  grCasoId: string | null;
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
}
```

## Architecture Decisions

### AD-1 — Persistir en Prisma con FK al Client (patrón ScheduledTask)

**Choice**: `model Ticket` con `customerId String?` FK → `Client`, `customerName` derivado por JOIN en el mapper, NO almacenado.

**Alternatives**:
- Mantener `clientId String` texto libre (como la entidad actual). Rechazado — no permite contar/joinear de forma confiable; es exactamente la deuda que el usuario quiere pagar.
- `customerId` NOT NULL (obligatorio). Rechazado — habría tickets internos sin cliente; `ScheduledTask` lo dejó opcional (`8048001d`) por la misma razón. Se mantiene nullable.

**Rationale**: Consistencia total con el agregado de tareas, que ya resuelve el mismo problema ("Tareas (N)" por cliente).

### AD-2 — Reemplazar el backing, conservar los contratos (no big-bang)

**Choice**: Los use cases `ListTickets`/`CreateTicket`/`GetTicketStats` y la API HTTP se conservan; cambia el adapter inyectado (`SplynxTicketAdapter` → `PrismaTicketRepository`). `SplynxTicketAdapter` NO se borra.

**Alternatives**:
- Borrar Splynx y los use cases y reescribir de cero. Rechazado — rompe la superficie HTTP que el front ya consume y elimina el rollback fácil.
- Convivencia dual (leer de Splynx Y Prisma). Rechazado — Splynx está caído (licencia vencida); no aporta datos, solo complejidad.

**Rationale**: El puerto es la costura. Cambiar la implementación detrás del puerto es exactamente para lo que existe la arquitectura hexagonal. Superficie estable + rollback por re-wiring.

### AD-3 — Un set canónico de `status`: enum `open | pending | closed`

**Choice**: Enum Prisma `TicketStatus { open, pending, closed }`. La API expone esos valores en inglés. Se descarta el español de la entidad actual (`'abierto'|'en_progreso'|'cerrado'`) y el `'resolved'` huérfano de la route.

**Alternatives**:
- Mantener español. Rechazado — la route ya valida en inglés (`tickets.routes.ts:113`); el front probablemente ya mapea inglés. Menos cambios netos.
- `String` libre con default. Rechazado — reintroduce el drift que estamos eliminando; un enum da integridad a nivel DB.
- Incluir `resolved`. Descartado — no hay consumidor real verificado; "cerrado" cubre el caso. Si el front lo necesita, se agrega al enum (cambio aditivo barato).

**Rationale**: El usuario pidió explícitamente "open/closed/pending?" como hipótesis. El enum elimina el drift de raíz y documenta los estados válidos en el schema.

**Coordinación**: el frontend debe enviar/leer `open|pending|closed`. Si hoy muestra `'abierto'`, mapea en la capa de presentación (no en el dato).

### AD-4 — `onDelete: SetNull` en `customerId`

**Choice**: Igual que `ScheduledTask.customer` (`onDelete: SetNull`). Borrar un cliente deja sus tickets con `customerId=null` (histórico preservado).

**Alternatives**:
- `Cascade` (borrar cliente borra tickets). Rechazado — pierde el historial de soporte; inconsistente con tareas.
- `Restrict`. Rechazado — bloquearía borrar clientes con tickets; fricción operativa.

**Rationale**: Consistencia con el agregado de tareas y preservación del historial.

### AD-5 — `grCasoId` previsto pero no usado (futuro GR)

**Choice**: Agregar `grCasoId String? @unique` ahora, sin lógica que lo pueble.

**Rationale**: Los modelos del repo ya enlazan a sistemas externos con este patrón (`Client.grClienteId`, `Service.grContratoId`, ambos `@unique`). Dejar la columna lista evita una segunda migration cuando llegue la integración de "casos" de Gestión Real. Costo cero hoy, ahorro de coordinación mañana. Out-of-scope: ninguna escritura ni lectura de este campo en este cambio.

### AD-6 — Replies de ticket quedan fuera (in-memory por ahora)

**Choice**: NO modelar `TicketReply` en esta iteración. `ticketRepliesStore` puede quedar in-memory tras la route, o congelarse.

**Alternatives**:
- Modelar `TicketReply` con FK `ticketId` ahora. Aplazado — agranda el scope; el pedido del usuario es el contador/listado por cliente, no el hilo de conversación.

**Rationale**: Entregar el valor pedido (tickets reales por cliente) sin arrastrar el modelo de conversación. `TicketReply` queda como cambio siguiente, con FK `onDelete: Cascade` al `Ticket` (patrón `ClientLog`/`TaskWatcher`).

### AD-7 — El conteo sale de la BD, no de `shared-stores`

**Choice**: `getStats` y "Tickets (N)" se resuelven con `COUNT(*)`/`findMany` sobre la tabla real. Se retiran `incrementTickets/decrementTickets` del flujo de la route.

**Rationale**: Con datos reales, los contadores manuales in-memory son una fuente de verdad paralela que se desincroniza. La BD es la única fuente.

## Puerto propuesto (`domain/ports/TicketRepository.ts`)

```ts
export interface ListTicketsQuery extends PaginatedQuery {
  search?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;            // NEW — habilita "Tickets (N)" por cliente
}

export interface CreateTicketData {
  subject: string;
  description: string;
  customerId?: string | null;     // FK (antes clientId texto libre)
  priority?: TicketPriority;
  assigneeId?: string | null;
}

export interface UpdateTicketData {
  subject?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
}

export interface TicketRepository {
  list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>>;
  getById(id: string): Promise<Ticket | null>;              // NEW
  getStats(): Promise<TicketStats>;
  create(data: CreateTicketData): Promise<Ticket>;
  update(id: string, data: UpdateTicketData): Promise<Ticket | null>;  // NEW (cubre status/assign/edit)
  close(id: string): Promise<Ticket | null>;                // NEW — status=closed
}
```

`update` unifica los stores in-memory de la route (`ticketStatusStore`, `ticketEditsStore`, `ticketAssignmentStore`) en una sola operación contra columnas reales. `close` es azúcar sobre `update({ status: 'closed' })` para que el botón "cerrar ticket" sea explícito.

## Frontend Coordination Contract

| Pieza | Llamada | Patrón espejado |
|-------|---------|-----------------|
| Botón "Tickets (N)" en info del cliente | `GET /api/tickets?customerId={id}` → usar `total` (o `data.length`) | idéntico a "Tareas (N)" → `GET /api/scheduling?customerId={id}` |
| Listado filtrado al hacer click | navegar a la lista de tickets pasando `customerId` en el query | idéntico al deep-link de tareas por cliente |
| Crear ticket desde el cliente | `POST /api/tickets` con `{ subject, description, customerId, priority }` | — |
| Cambiar estado / cerrar | `PATCH /api/tickets/:id` (`{ status }`) o `PATCH /api/tickets/:id/status` | mantener la ruta que ya consume el front |
| Tipo `Ticket` (front) | alinear: `customerId`, `customerName`, `status: 'open'\|'pending'\|'closed'`, `priority: 'low'\|'medium'\|'high'` | — |

El front debe migrar cualquier uso de `clientId`/`clientName` texto libre a `customerId`/`customerName`, y el vocabulario de status/priority al canónico (AD-3). Si hoy renderiza español, mapear en presentación.

## Code Change Map

| File | Acción |
|------|--------|
| `prisma/schema.prisma` | nuevo `model Ticket` + enums + back-relations en `Client`/`Admin` |
| `prisma/migrations/<ts>_add_ticket_model/` | nueva migration (la genera el usuario con `prisma:migrate`) |
| `src/domain/entities/ticket.ts` | nueva forma de `Ticket` (FK, JOIN-derived, status/priority canónicos) |
| `src/domain/ports/TicketRepository.ts` | `customerId` en query; `getById`/`update`/`close`; tipos de status/priority |
| `src/application/dto/tickets.dto.ts` | `customerId` en filtro + DTO de salida (no entidad cruda); DTO update |
| `src/application/use-cases/ListTickets.ts` | pasar `customerId` al repo |
| `src/application/use-cases/GetTicket.ts` | nuevo |
| `src/application/use-cases/UpdateTicketStatus.ts` | nuevo |
| `src/application/use-cases/CloseTicket.ts` | nuevo |
| `src/infrastructure/adapters/prisma/PrismaTicketRepository.ts` | nuevo — mapper `toTicket` + `INCLUDE { customer, assignee }` |
| `src/infrastructure/adapters/in-memory/InMemoryTicketRepository.ts` | nuevo — para tests |
| `src/infrastructure/adapters/in-memory/shared-stores.ts` | retirar `incrementTickets/decrementTickets` del flujo |
| `src/infrastructure/http/routes/tickets.routes.ts` | reescribir backing a use cases reales; passthrough `?customerId`; replies quedan in-memory (AD-6) |
| `src/infrastructure/http/app.ts` | `new PrismaTicketRepository(prisma)` reemplaza `new SplynxTicketAdapter(...)` en el wiring de tickets |

## Migration Plan

La migration la genera el usuario con `npm run prisma:migrate` (regla del repo: nunca SQL a mano). Es **aditiva**: `CREATE TABLE "Ticket"`, dos enums, una FK a `Client` y otra a `Admin`, e índices. No altera datos preexistentes.

Down (manual): `DROP TABLE "Ticket"; DROP TYPE "TicketStatus"; DROP TYPE "TicketPriority";`. Sin pérdida de datos (no había tabla).

## Testing Strategy (STRICT TDD)

| Foco | Tipo |
|------|------|
| `ListTickets` con `customerId` filtra solo los de ese cliente (InMemory) | Unit (use case) |
| `CreateTicket` persiste `customerId` y deriva `customerName` (InMemory) | Unit |
| `UpdateTicketStatus`/`CloseTicket` cambian el estado y persisten | Unit |
| `GET /api/tickets?customerId=X` devuelve solo los del cliente + `total` correcto | supertest |
| `POST /api/tickets` con `customerId` → 201 y aparece en el conteo del cliente | supertest |
| `PATCH /api/tickets/:id/status` persiste (no override in-memory) | supertest |
| Mapper `toTicket`: `customerName` viene SOLO del JOIN (null si no hay `customerId`) | Unit (Prisma mapper) |
| `tsc --noEmit` verde tras cambio de entidad/DTO | type check |

InMemory primero (red→green), igual que el resto del repo. NO mockear Prisma.

## Open Questions

1. **¿`resolved` es necesario?** La route lo valida hoy pero no hay consumidor verificado. Propuesta: omitir; agregarlo al enum es aditivo si el front lo requiere.
2. **¿Replies ahora o después?** Recomendado después (AD-6). Confirmar con el usuario que la UI de hilo puede seguir in-memory una iteración más.
3. **¿`assigneeId` es FK a `Admin` o texto libre?** Propuesto FK (espejo de `ScheduledTask.assigneeId`). Si la UI de asignación manda nombres libres, se resuelve con match por nombre o se deja `assigneeName` libre — confirmar.
4. **Seed**: ¿se quiere algún ticket de ejemplo en `prisma/seed.ts`, o arrancar vacío ("se va cargando a futuro")? El pedido sugiere vacío.
