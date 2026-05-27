# customer-repository-write Specification

## Purpose

Extensión del port `CustomerRepository` con métodos de escritura, implementación real en `PrismaClientRepository`, y dejar `SplynxCustomerAdapter` presente-pero-sin-wiring durante este cambio.

## Requirements

### Requirement: CustomerRepository Port — Write Methods

The port `CustomerRepository` MUST declare the following write methods: `create(input)`, `update(id, partial)`, `delete(id)`, `changeStatus(id, status)`. All methods MUST return domain entities or void — no Prisma types leak into the port signature.

#### Scenario: Firma del port verificable

- GIVEN `src/domain/ports/CustomerRepository.ts`
- WHEN inspección o `tsc --noEmit`
- THEN el port declara los 4 métodos de escritura sin importar tipos de Prisma
- AND métodos de lectura existentes se mantienen (no regression)

#### Scenario: Violación de contrato detectada en compile time

- GIVEN una clase que `implements CustomerRepository` sin implementar `delete(id)`
- WHEN `tsc --noEmit`
- THEN error TS2420 — propiedad faltante

---

### Requirement: PrismaClientRepository — Full Implementation

The class `PrismaClientRepository` MUST implement ALL methods of `CustomerRepository` (read + write). The class MUST be exported as `PrismaClientRepository` — no other name. It MUST import from `@prisma/client`, never from `@infrastructure/*` transitively through the domain.

#### Scenario: Nombre de clase correcto

- GIVEN `src/infrastructure/adapters/prisma/PrismaClientRepository.ts`
- WHEN `rg "export class" src/infrastructure/adapters/prisma/PrismaClientRepository.ts`
- THEN output contiene `export class PrismaClientRepository`

#### Scenario: Create persiste en Postgres

- GIVEN instancia de `PrismaClientRepository` con Prisma client real (test integración)
- WHEN `repo.create({ firstName: "Ana", email: "ana@test.com", ... })`
- THEN registro existe en tabla `Client` con UUID asignado y `status: active`

#### Scenario: Update modifica solo los campos enviados

- GIVEN cliente existente con `phone: null`
- WHEN `repo.update(id, { phone: "099123456" })`
- THEN registro en Postgres tiene `phone: "099123456"`; resto de campos sin cambio

#### Scenario: Delete elimina el registro

- GIVEN cliente existente sin dependencias
- WHEN `repo.delete(id)`
- THEN registro ya no existe en Postgres (`prisma.client.findUnique` → null)

#### Scenario: ChangeStatus actualiza el campo status

- GIVEN cliente con `status: active`
- WHEN `repo.changeStatus(id, "blocked")`
- THEN registro en Postgres tiene `status: "blocked"`

---

### Requirement: SplynxCustomerAdapter — Dormant (No Wiring)

The `SplynxCustomerAdapter` MUST remain present in the codebase and MUST compile without errors. It MUST NOT be wired in `app.ts` or any DI entry point during this change.

#### Scenario: Adapter compila sin error

- GIVEN `SplynxCustomerAdapter` existente
- WHEN `tsc --noEmit`
- THEN 0 errores — el adapter sigue siendo código TypeScript válido

#### Scenario: Adapter no está wired en app.ts

- GIVEN `src/infrastructure/http/app.ts`
- WHEN `rg "SplynxCustomerAdapter" src/infrastructure/http/app.ts`
- THEN 0 matches — no aparece instanciado ni inyectado

---

## Invariants

- I-1: `CustomerRepository` port NO importa tipos de Prisma. Verifiable: `rg "from '@prisma" src/domain/ports/CustomerRepository.ts` → 0 matches.
- I-2: `PrismaClientRepository` es la ÚNICA implementación inyectada en `app.ts`. Verifiable: `rg "CustomerRepository" src/infrastructure/http/app.ts` → solo `PrismaClientRepository` en la instanciación.
- I-3: Application layer usa el port por interfaz, no la clase concreta. Verifiable: use cases no importan `PrismaClientRepository` directamente — solo `CustomerRepository`.
