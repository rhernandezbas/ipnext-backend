# Design: clients-foundation

## Technical Approach

Modelar `Client` como agregado Postgres-first (UUID PK, `splynxId? @unique`) con catálogos editables (`ClientType`, `Segment`) y enum nativo `ClientStatus`. Mantener la entity de dominio como **interfaz `Customer`** (no clase) para no romper 322 tests existentes; un mapper traduce `prisma.client ↔ Customer`. Validación zod en boundary HTTP (`src/infrastructure/http/schemas/`); use cases reciben tipos inferidos. Errores Prisma se atrapan en el adapter y se convierten en `DomainError`. Wiring en `app.ts` agrupado bajo `// === Clients ===` (sin DI container). Splynx adapter queda dormido (no se referencia). 5 commits atómicos; cada uno verde antes de avanzar.

## Architecture Decisions

| # | Decisión | Elegido | Alternativa rechazada | Razón |
|---|----------|---------|----------------------|-------|
| 1 | Domain entity shape | `Customer` interface + factory | Class con métodos / renombrar a `Client` | 322 tests dependen de la interfaz; renombrar = ruptura masiva. Prisma model `Client` queda solo en infra |
| 2 | zod ubicación | `src/infrastructure/http/schemas/` | `src/application/dto/` | zod es detalle de boundary HTTP. Application recibe tipos puros (`z.infer`) — hexagonal limpio |
| 3 | Tipos `CreateClientInput` / `UpdateClientInput` | En el port (`CustomerRepository.ts`) | En `application/dto/` | Son contratos de dominio. Schemas zod HTTP son distintos y se mapean en la route |
| 4 | Eliminación con servicios activos | **POSTERGADO** a `clients-data-migration` | Stub que devuelve "sin servicios" | `ClientService` no existe en este change. Borrado incondicional documentado como deuda explícita |
| 5 | Migration | UNA migration `add_client_model_and_catalogs` | Múltiples migrations encadenadas | Atomicidad: enum + tablas + FKs + índices se crean juntos. Reversible vía `prisma migrate reset` |
| 6 | Cache catálogos `/catalogs` | NO en V1 | Cache HTTP / in-memory | Catálogos son pequeños; performance medida primero |
| 7 | Pluralización rutas | Mantener `/api/clients`, `/api/client-types`, `/api/segments` | Renombrar a `/api/customers` | Consistencia con paths existentes |
| 8 | Mapeo Prisma → Customer | Mapper puro en `src/infrastructure/adapters/prisma/mappers/clientMapper.ts` | Cada repo método mapea inline | Reutilización entre `findById/list/create/update` y testeable aislado |
| 9 | Validación en mapper | NO — confiar en types entre capas | Re-validar zod en mapper | Validación vive en boundary HTTP. Mapper solo traduce |
| 10 | Error handling Prisma | Adapter atrapa `P2002`/`P2025` y lanza `DomainError` | Leak Prisma error al use case | Ningún `Prisma.*` debe llegar a `application/` ni HTTP |

## Data Flow

```
HTTP request
   │
   ▼
[validate middleware] ──► zod schema (createClientSchema, etc.)
   │  z.infer<...>
   ▼
[route handler] ──► useCase.execute(input)
   │
   ▼
[CreateClient use case] ──► CustomerRepository.create(input)
   │
   ▼
[PrismaClientRepository] ──► prisma.client.create(...)
   │  try/catch P2002/P2025 → throw DomainError
   ▼
[clientMapper.toDomain(row)] ──► Customer
   │
   ▼
HTTP response (JSON)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | Add enum `ClientStatus`, models `Client`/`ClientType`/`Segment` con FKs e índices |
| `prisma/migrations/<ts>_add_client_model_and_catalogs/migration.sql` | Create | Migration única |
| `prisma/seed.ts` | Create | Seed idempotente (`upsert` por `slug`) ClientType + Segment |
| `src/domain/entities/customer.ts` | Modify | Agregar `splynxId?`, `clientTypeId?`, `segmentId?`, `partnerId?`, `ubicacionId?` opcionales |
| `src/domain/ports/CustomerRepository.ts` | Modify | Agregar `create`/`update`/`delete`/`changeStatus` + tipos `CreateClientInput`/`UpdateClientInput`; agregar `listClientTypes`/`listSegments` |
| `src/domain/errors/index.ts` | Modify | Agregar `EmailAlreadyExistsError`, `LoginAlreadyExistsError`, `SplynxIdImmutableError` |
| `src/infrastructure/adapters/prisma/PrismaClientRepository.ts` | Create | Implementa `CustomerRepository`. Try/catch Prisma errors → DomainError |
| `src/infrastructure/adapters/prisma/mappers/clientMapper.ts` | Create | `toDomain(row): Customer` y `toCreateInput(input)` |
| `src/application/use-cases/CreateClient.ts` | Create | + test TDD |
| `src/application/use-cases/UpdateClient.ts` | Create | Verifica `splynxId` inmutable; + test |
| `src/application/use-cases/DeleteClient.ts` | Create | Borra incondicional (deuda) + test |
| `src/application/use-cases/ChangeClientStatus.ts` | Create | + test |
| `src/application/use-cases/ListClientTypes.ts` | Create | + test |
| `src/application/use-cases/ListSegments.ts` | Create | + test |
| `src/application/use-cases/GetClientCatalogs.ts` | Create | Compone con `Promise.all` (clientTypeRepo, segmentRepo, plan, partner, ubicacion) + test |
| `src/infrastructure/http/schemas/client.schemas.ts` | Create | `createClientSchema`, `updateClientSchema`, `listClientsQuerySchema`, `changeClientStatusSchema` |
| `src/infrastructure/http/middleware/validate.ts` | Create | Middleware genérico `validate(schema)` |
| `src/infrastructure/http/routes/clients.routes.ts` | Modify | POST/PATCH/DELETE/status pasan por use cases; agregar `GET /catalogs` ANTES de `GET /:id` |
| `src/infrastructure/http/app.ts` | Modify | Bloque `// === Clients ===` con `prismaClientRepo`; `customerAdapter` (Splynx) eliminado del wiring |
| `src/infrastructure/adapters/in-memory/shared-stores.ts` | Modify | Remover `sharedClientStore`, `incrementClients`, `decrementClients` |
| `src/infrastructure/adapters/in-memory/InMemoryDashboardRepository.ts` | Modify | Reemplazar lectura `sharedClientStore` por inyección de `prisma.client.count(...)` |
| `package.json` | Modify | Agregar `zod` ^3.x |

## Interfaces / Contracts

```ts
// src/domain/ports/CustomerRepository.ts (extracto nuevo)
export type ClientStatus = 'active' | 'late' | 'blocked' | 'inactive';

export interface CreateClientInput {
  name: string; email: string; login: string; phone?: string;
  address?: string; city?: string; country?: string;
  status?: ClientStatus; splynxId?: string;
  clientTypeId?: string; segmentId?: string;
  partnerId?: string; ubicacionId?: string;
  customAttributes?: Record<string, string>;
}
export interface UpdateClientInput {
  name?: string; email?: string; login?: string; phone?: string;
  address?: string; city?: string; country?: string;
  clientTypeId?: string; segmentId?: string;
  partnerId?: string; ubicacionId?: string;
  customAttributes?: Record<string, string>;
  // splynxId NO presente — inmutable post-creación
}

export interface CustomerRepository {
  // reads (existentes)
  list(query: ListClientsQuery): Promise<PaginatedResult<Customer>>;
  findById(id: string): Promise<Customer>;
  listServices(clientId: string): Promise<Service[]>;
  listInvoices(clientId: string): Promise<Invoice[]>;
  listLogs(query: ListLogsQuery): Promise<PaginatedResult<ClientLog>>;
  // writes (nuevos)
  create(input: CreateClientInput): Promise<Customer>;
  update(id: string, partial: UpdateClientInput): Promise<Customer>;
  delete(id: string): Promise<void>;
  changeStatus(id: string, status: ClientStatus): Promise<Customer>;
}

// catálogos
export interface ClientTypeRepository { list(): Promise<ClientType[]>; }
export interface SegmentRepository { list(): Promise<Segment[]>; }
```

```prisma
// prisma/schema.prisma (extracto)
enum ClientStatus { active late blocked inactive }

model Client {
  id            String       @id @default(uuid())
  splynxId      String?      @unique
  name          String
  email         String       @unique
  login         String       @unique
  phone         String?
  address       String?
  city          String?
  country       String?
  status        ClientStatus @default(active)
  customAttributes Json?
  partnerId     String?
  partner       Partner?     @relation(fields: [partnerId], references: [id])
  ubicacionId   String?
  ubicacion     Ubicacion?   @relation(fields: [ubicacionId], references: [id])
  clientTypeId  String?
  clientType    ClientType?  @relation(fields: [clientTypeId], references: [id])
  segmentId     String?
  segment       Segment?     @relation(fields: [segmentId], references: [id])
  createdAt     DateTime     @default(now())
  updatedAt     DateTime     @updatedAt

  @@index([status])
  @@index([partnerId])
  @@index([segmentId])
  @@index([clientTypeId])
  @@index([ubicacionId])
  @@index([splynxId])
}

model ClientType { id String @id @default(uuid()) name String @unique slug String @unique createdAt DateTime @default(now()) updatedAt DateTime @updatedAt clients Client[] }
model Segment    { id String @id @default(uuid()) name String @unique slug String @unique createdAt DateTime @default(now()) updatedAt DateTime @updatedAt clients Client[] }
```

```ts
// src/infrastructure/http/middleware/validate.ts (firma)
export const validate = <T extends z.ZodTypeAny>(schema: T) =>
  (req, res, next) => { /* parse → req.body | next(400) */ };
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | Cada use case (Create/Update/Delete/ChangeStatus/ListTypes/ListSegments/GetCatalogs) | Strict TDD: RED test contra port mockeado → GREEN |
| Unit | `clientMapper.toDomain` con todos los campos opcionales | Pure-function tests |
| Unit | `UpdateClient` rechaza `splynxId` en payload | Test específico (I-3 spec) |
| Integration | Routes POST/PATCH/DELETE/`/status` con supertest + Prisma de test | DB efímera por test (transaction rollback o test-DB) |
| Integration | `GET /api/clients/catalogs` shape correcto | supertest + seed |
| Integration | `GET /api/clients/catalogs` registrado ANTES de `/:id` | Test de orden de routes |
| Non-regression | 322 tests existentes | Suite completa al cierre commit 4 |
| Static | `tsc --noEmit` 0 errores | CI guard |
| Static | `rg "from '@infrastructure" src/application/use-cases/` → 0 | Invariant I-1 |

## Migration / Rollout

- **Migration**: `npx prisma migrate dev --name add_client_model_and_catalogs` crea enum + 3 tablas + FKs + índices.
- **Seed**: `npx prisma db seed` ejecuta `prisma/seed.ts`. Idempotente vía `upsert` por `slug`.
  - ClientType: `persona`, `empresa`, `reseller`
  - Segment: `residencial`, `pyme`, `corporativo`
- **Rollback dev**: `prisma migrate reset` recrea DB vacía + seed.
- **Rollback prod**: `git revert` por commit + `prisma migrate resolve --rolled-back`.
- **Splynx adapter**: queda compilando, no wired. Reactivable revirtiendo el wiring de `app.ts`.
- **Frontend**: lista vacía hasta `clients-data-migration` o creación nueva por POST. ACEPTADO (decisión post-proposal Q2).

## Commit Order (DAG estricto)

| # | Commit | Verificación gate |
|---|--------|-------------------|
| 1 | `feat(clients): schema + migration + seed` | `prisma migrate dev` ok + seed idempotente + `tsc --noEmit` |
| 2 | `feat(clients): domain + application (TDD)` | tests use cases + tests existentes verdes |
| 3 | `feat(clients): infrastructure (Prisma repo + zod + validate middleware)` | tests unit nuevos + `tsc --noEmit` |
| 4 | `feat(clients): http routes refactor + /catalogs + wiring` | suite completa + tests integración |
| 5 | `refactor(dashboard): replace sharedClientStore with prisma counts` | suite completa, sin regresión |

Cada commit DEBE pasar `tsc --noEmit` y `npm test` antes de avanzar. Conventional commits sin `Co-Authored-By`.

## Open Questions

- [ ] **Test DB strategy**: ¿Prisma test DB separada (recomendado) o transaction rollback por test? Hoy 322 tests no usan Prisma real para clients — definir antes de Commit 4.
- [ ] **Wiring `customerAdapter` Splynx**: ¿se elimina la línea de `app.ts` (limpio) o queda comentada (rollback fácil)? Recomendación: eliminar línea, dejar import sin usar comentado con `// dormant — see clients-data-migration`.
