# Proposal: clients-foundation

> **STATUS: BLOQUEADO / EN PAUSA (2026-06-02).** Este change NO se construye hasta que se corte el sync de Gestion Real (GR).
>
> **Por que:** mientras el sync de GR este activo, GR es la unica fuente de verdad de los datos del cliente. Construir CRUD manual (UpdateClient/ChangeClientStatus) ahora es trabajo muerto: `ReconcileGrClients` pisaria cualquier edicion local en la proxima corrida -> doble fuente de verdad -> se percibe como bug ("edite y no se guardo").
>
> **El proposal de abajo esta OBSOLETO:** gran parte ya se implemento via los changes de GR (gr-clients-full-universe, gr-client-balance-sync). YA EXISTEN: `model Client` (con grClienteId + balance), enum `ClientStatus` nativo (active/late/blocked/inactive/baja), `PrismaCustomerRepository` (read+write a Postgres), use-cases ListClients/GetClientDetail/CreateCustomer/DeleteCustomer, y el sync GR. Pendiente genuino: catalogos ClientType/Segment, UpdateClient/ChangeClientStatus, y GET /api/clients/catalogs.
>
> **Cuando desbloquear:** el dia que se decida cortar GR, este change se REPLANTEA como migracion de *ownership* (flag por cliente / freeze global del sync / last-write-wins) — NO es un simple "agregar use-cases". Es un proyecto con estrategia de transicion (patron Strangler Fig).

## Intent

Construir el módulo de Clientes con CRUD completo, persistencia en Postgres, validación con zod y catálogos editables — cimientos para reemplazar Splynx como sistema operacional. NO incluye importación de datos legacy (eso vive en `clients-data-migration`). Hoy POST/PATCH/DELETE/status escriben a stores in-memory volátiles; el dashboard lee contadores manuales; no hay modelo `Client` en Prisma. Este cambio establece la base de datos real, los puertos de escritura del dominio, los use cases CRUD y el wiring HTTP para que toda operación de cliente persista en Postgres.

## Scope

### In Scope
- Modelos Prisma `Client` (UUID PK, `splynxId? @unique`, FKs a `Partner`/`Ubicacion`/`ClientType`/`Segment`), `ClientType`, `Segment` con seed idempotente.
- Migration Prisma (creación de tablas + seed inicial razonable).
- Extensión del port `CustomerRepository` con `create`, `update`, `delete`, `changeStatus`.
- Adapter real `PrismaClientRepository` (clase exportada con nombre coherente, no `InMemory*`).
- Use cases: `CreateClient`, `UpdateClient`, `DeleteClient`, `ChangeClientStatus`, `ListClientTypes`, `ListSegments`, `GetClientCatalogs`.
- DTOs + zod schemas en boundary HTTP/application; el dominio recibe DTOs ya validados.
- Refactor de `clients.routes.ts`: POST/PATCH/DELETE/status pasan por use cases (no más `newClientsStore`/`deletedClientsStore`).
- Nuevo `GET /api/clients/catalogs` agregado: `{ statuses, types, segments, partners, ubicaciones, servicePlans }`.
- Wiring en `app.ts` (DI manual, agrupado por módulo con comentarios — sin abrir el refactor del God Object).
- Tests unitarios por use case (Strict TDD: rojo → verde) + tests de integración del endpoint de catálogos.
- Reemplazo atómico de `sharedClientStore` (contadores) por queries Prisma en el repo del dashboard.

### Out of Scope (EXPLÍCITO)
- Importación de datos desde Splynx → `clients-data-migration`.
- Modelos `ClientDocument`, `ClientFile`, `ClientService` → `clients-data-migration`.
- Migración de `onlineSessions` a `RadiusSession` → `clients-data-migration`.
- Eliminación del `SplynxCustomerAdapter` → `clients-data-migration` (queda dormido como fallback de lectura legacy si algún caller lo invoca).
- Refactor del God Object `app.ts` (conocido, postergado).
- DI container.
- Stores in-memory de documents/files/services (siguen volátiles hasta `clients-data-migration`).

## Capabilities

### New Capabilities
- `client-management`: CRUD del agregado `Client` (create, update, delete, change-status) con persistencia Postgres, validación zod en boundary y reglas de dominio (unicidad email/login, transiciones de status, no borrar con dependencias).
- `client-catalogs`: Lectura agregada de catálogos (`ClientType`, `Segment`, statuses, partners, ubicaciones, service plans) para alimentar formularios de admin.

### Modified Capabilities
- None (no hay specs previos en `openspec/specs/` para `clients` o `customer`; el read-only actual vivía en código sin spec formal y se incorpora al nuevo `client-management`).

## Approach

Estrategia: **5 commits atómicos**, cada uno reversible vía `git revert`, con dependencias hacia adelante.

1. **Commit 1 — Schema + migration + seed**: `prisma/schema.prisma` agrega `Client`, `ClientType`, `Segment` + enum `ClientStatus` (Postgres nativo). `prisma/migrations/<ts>_clients_foundation/`. `prisma/seed.ts` con `upsert` idempotente. Bloquea todo lo demás.
2. **Commit 2 — Domain + Application (TDD)**: actualiza entidad `Client`, extiende port con métodos de escritura, escribe tests fallidos primero y luego use cases (`CreateClient`, `UpdateClient`, `DeleteClient`, `ChangeClientStatus`, `ListClientTypes`, `ListSegments`, `GetClientCatalogs`). Application no importa de `@infrastructure/*`.
3. **Commit 3 — Infrastructure**: `PrismaClientRepository` (clase con nombre coherente, no `InMemory*`), zod schemas + DTOs, mapeo entity ↔ Prisma row.
4. **Commit 4 — HTTP**: refactor `clients.routes.ts` (use cases en POST/PATCH/DELETE/status), `GET /api/clients/catalogs`, wiring en `app.ts` (agrupado), tests de integración.
5. **Commit 5 — Dashboard counters**: reemplazo atómico de `sharedClientStore` por `prisma.client.count(...)` en el repo del dashboard. Sin regresión visible.

Justificación del orden: schema bloquea use cases; use cases bloquean adapter; adapter bloquea HTTP; HTTP estable habilita el swap del dashboard sin riesgo cruzado.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | Agrega `Client`, `ClientType`, `Segment`, enum `ClientStatus`, FKs |
| `prisma/migrations/<ts>_clients_foundation/` | New | Migration de creación + enum |
| `prisma/seed.ts` | Modified/New | Seed idempotente con `upsert` para `ClientType` y `Segment` |
| `src/domain/entities/customer.ts` (o `client.ts`) | Modified | Campos nuevos: `splynxId?`, `clientTypeId?`, `segmentId?`, `partnerId?`, `ubicacionId?` |
| `src/domain/ports/CustomerRepository.ts` | Modified | Agrega `create`, `update`, `delete`, `changeStatus`, `listClientTypes`, `listSegments` |
| `src/infrastructure/adapters/prisma/PrismaClientRepository.ts` | New | Adapter real, clase `PrismaClientRepository` |
| `src/application/use-cases/CreateClient.ts` | New | + tests TDD |
| `src/application/use-cases/UpdateClient.ts` | New | + tests TDD |
| `src/application/use-cases/DeleteClient.ts` | New | + tests TDD |
| `src/application/use-cases/ChangeClientStatus.ts` | New | + tests TDD |
| `src/application/use-cases/ListClientTypes.ts` | New | + tests |
| `src/application/use-cases/ListSegments.ts` | New | + tests |
| `src/application/use-cases/GetClientCatalogs.ts` | New | Agrega catálogos para UI |
| `src/application/dto/client/*.ts` | New | DTOs + zod schemas |
| `src/infrastructure/http/routes/clients.routes.ts` | Modified | POST/PATCH/DELETE/status → use cases; nuevo `/catalogs` |
| `src/infrastructure/http/app.ts` | Modified | Wiring de repo + 7 use cases nuevos (agrupado, no refactor) |
| `src/infrastructure/adapters/in-memory/shared-stores.ts` | Modified | Eliminar `sharedClientStore` (contadores) |
| Repo de dashboard | Modified | Contadores por `prisma.client.count` |
| `package.json` | Modified | `zod` en dependencies |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Doble fuente de verdad temporal (Splynx + Prisma) | Med | Recomendación: `ListClients`/`GetClientDetail` se inyectan SOLO con `PrismaClientRepository`. Datos legacy quedan invisibles hasta `clients-data-migration`. Frontend verá lista vacía hasta que se creen clientes nuevos o corra el data-migration. SplynxCustomerAdapter queda dormido (no se borra) por seguridad |
| Test count regression (322 hoy) | Low | Estimado: +15-20 tests nuevos. Correr suite completa al final del commit 4. Cero tolerancia a romper existentes |
| `status` como union TS vs enum Postgres | Low | Recomendación: enum Postgres nativo (consistencia con la decisión de modelar Type/Segment como tabla editable; status es lista cerrada de estados de billing — agregar uno requiere migration, esto es CORRECTO) |
| `app.ts` engorda con 1 repo + 7 use cases | Med | Mitigación: agrupar imports e instanciaciones por módulo con comentarios `// === Clients ===`. NO abrir refactor del God Object (out of scope) |
| Mezclar validación zod en domain | Med | Disciplina: zod vive en `infrastructure/http` y/o `application/dto`. Domain recibe DTOs validados. Tests del domain usan factories, no schemas |
| Seed corre múltiples veces y duplica catálogos | Low | `upsert` por `code`/`name` único. Idempotencia testeada |
| Clase del adapter mal nombrada (deuda histórica) | Low | Nombre obligatorio: `PrismaClientRepository` (NO `InMemoryClientRepository`). Quality gate `tsc --noEmit` |

## Rollback Plan

- Cada commit es revertible vía `git revert <sha>` independientemente.
- Migration Prisma reversible en dev con `prisma migrate reset` (recrea DB desde cero).
- Si el commit 4 (HTTP) rompe algo, revertir solo el 4 deja el dominio + adapter intactos para reintento.
- `SplynxCustomerAdapter` NO se elimina → si el wiring nuevo falla, revertir la línea de DI en `app.ts` lo reactiva.
- Para producción: rollback = revert de los commits + `prisma migrate resolve --rolled-back <migration>` y aplicar migration inversa manual si fuera necesario.

## Dependencies

- `zod` (nueva dep en `package.json`).
- Prisma 7.8 ya instalado (`@prisma/adapter-pg`).
- `Partner` y `Ubicacion` ya existen en schema (FK targets).
- `clients-data-migration` es DEPENDIENTE de este cambio (no al revés).

## Success Criteria

- [ ] `prisma migrate dev` corre sin error en entorno limpio.
- [ ] `prisma db seed` puebla `ClientType` y `Segment` con valores razonables; re-ejecutar es idempotente.
- [ ] Los 322 tests existentes siguen pasando.
- [ ] Tests nuevos: mínimo ~15-20 (use cases unitarios + integración del endpoint de catálogos).
- [ ] `tsc --noEmit` con 0 errores (quality gate).
- [ ] `GET /api/clients/catalogs` devuelve estructura agregada `{ statuses, types, segments, partners, ubicaciones, servicePlans }`.
- [ ] `POST /api/clients` persiste en Postgres (verificable con `prisma studio`).
- [ ] `PATCH /api/clients/:id`, `DELETE /api/clients/:id`, `PATCH /api/clients/:id/status` operan contra Postgres.
- [ ] Dashboard counters siguen funcionando (sin regresión); `sharedClientStore` eliminado.
- [ ] Application no importa de `@infrastructure/*` (verificable por inspección + `tsc`).
- [ ] Clase exportada del adapter se llama `PrismaClientRepository` (no `InMemory*`).
- [ ] zod vive en boundary HTTP/application; domain recibe DTOs ya validados.

## Open Questions (para confirmar antes de spec)

1. **`status` como enum nativo Postgres vs string libre**: recomendación → **enum Postgres nativo**. Justificación: status es una lista cerrada (`active`, `late`, `blocked`, `inactive`); agregar un valor debe ser explícito (migration) — coherente con que Type/Segment SÍ sean tablas editables (esos son catálogos de negocio, status es máquina de estados). ¿Confirmás enum nativo?
2. **Adapter para reads (`ListClients` / `GetClientDetail`) durante este cambio**: recomendación → **solo `PrismaClientRepository`**. Splynx queda dormido (código presente, sin wiring). Implicancia: hasta que corra `clients-data-migration`, el frontend verá lista vacía si no se crean clientes nuevos por POST. La alternativa es un compositor con fallback chain (Prisma → Splynx por `splynxId`), pero suma complejidad al port y mezcla responsabilidades. ¿Confirmás solo Prisma, o querés fallback chain?
