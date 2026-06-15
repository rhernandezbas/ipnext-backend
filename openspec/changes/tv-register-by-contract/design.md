# Design — tv-register-by-contract

## Contexto del seam (explorado)

- `RegisterGigaredAccount.execute` (`src/application/use-cases/gigared/RegisterGigaredAccount.ts`):
  - L92-94: guard `customer.grClienteId` → `GrClientIdRequiredError`.
  - L95-96: `const grClienteId = customer.grClienteId; const password = deterministicTvPassword(grClienteId);`
  - L99-101: guard CUA `isValidGigaredPassword(password)` → `GrClientIdRequiredError`.
  - L116-124: `wantsPersist` (sólo cuando hay `contractId` + repos) → valida ownership del contrato.
    HOY la validación de ownership es CONDICIONAL a la persistencia.
  - L137: `email = seq > 0 ? deterministicTvEmail(input.lastName, grClienteId, seq) : input.email`.
  - `input.contractId?` es OPCIONAL.
- `ContractLookup` (`src/application/use-cases/gigared/lookups.ts` L29-31): `findById(id) → { id, clientId } | null`.
  NO expone `grContratoId`.
- `prismaContractOwnershipLookup` (`src/infrastructure/http/app.ts` L648-650):
  `prisma.contract.findUnique({ where: { id }, select: { id: true, clientId: true } })`. Es el lookup
  inyectado a `RegisterGigaredAccount` (app.ts L1830 `gigaredContractLookup`, L1851 el `new`).
- `Contract.grContratoId String? @unique` (`prisma/schema.prisma` L228) — ya existe, poblado por GR sync.
- Helpers (`src/infrastructure/security/gigaredPassword.ts`):
  - `deterministicTvPassword(grId: string)` — firma genérica, NO cambia.
  - `deterministicTvEmail(lastName, grId, seq = 0)` — firma genérica, NO cambia.
  Sólo cambia QUÉ id se les pasa (contrato en vez de cliente).
- `currentTvInternalId(clientId, seq)` (`src/domain/gigared/tvIdentity.ts`) — NO cambia (internal_id
  sigue por cliente).
- Ruta `POST /api/gigared/customers/:id/register` (`src/infrastructure/http/routes/gigared.routes.ts`
  L283-318): `contractId` opcional con strip silencioso; `password`/`cic` descartados.
- Errores (`src/domain/errors/gigared.ts`) + mapeo (`gigared.routes.ts sendGigaredError`).
- Tests:
  - Use case: `src/__tests__/application/RegisterGigaredAccount.usecase.test.ts`. Helper
    `fakeCustomerLookup(found, grClienteId)`. Hoy NO inyecta contractLookup en la mayoría de casos.
  - Routes: `src/__tests__/infrastructure/gigared.routes.test.ts`. Helper `contractLookup` in-memory
    (L126-129) devuelve `{ id, clientId }`.

## Cambios

### 1. Dominio — error nuevo `GrContractIdRequiredError`
Archivo: `src/domain/errors/gigared.ts`.
```ts
export class GrContractIdRequiredError extends DomainError {
  constructor(
    public readonly contractId: string,
    message = 'El contrato no tiene ID de Gestión Real — no se puede generar la identidad de TV',
  ) {
    super(message, 'GR_CONTRACT_ID_REQUIRED');
    this.name = 'GrContractIdRequiredError';
  }
}
```
Code nuevo en el contrato de wire: `GR_CONTRACT_ID_REQUIRED → 422`.

### 2. Application — `ContractLookup` expone grContratoId
Archivo: `src/application/use-cases/gigared/lookups.ts`.
```ts
export interface ContractLookup {
  findById(id: string): Promise<{ id: string; clientId: string; grContratoId?: string | null } | null>;
}
```
Opcional (`?`) para no romper los callers que sólo leen `id`/`clientId` (link/cancel/packs/change-password
siguen compilando sin tocarse).

### 3. Application — `RegisterGigaredAccount` deriva del contrato + contrato requerido
Archivo: `src/application/use-cases/gigared/RegisterGigaredAccount.ts`.

- `input.contractId` pasa a REQUERIDO en el tipo del input (string, sin `?`).
- El `contractLookup` deja de ser opcional para esta lógica: el alta SIEMPRE resuelve y valida el
  contrato (ownership) ANTES de Gigared, no sólo cuando `wantsPersist`.
- Reescritura del bloque de derivación (reemplaza L89-137):
  1. Validar `customer` existe (igual que hoy).
  2. Resolver contrato vía `contractLookup.findById(input.contractId)`. Si no existe o
     `contract.clientId !== customerId` → `ContractNotFoundError` (404). Esto sube la validación de
     ownership a SIEMPRE (antes era condicional a `wantsPersist`).
  3. Leer `grContratoId = contract.grContratoId`. Si es `null`/`''` → `GrContractIdRequiredError`
     (422). REEMPLAZA al guard `grClienteId` para el alta.
  4. `password = deterministicTvPassword(grContratoId)`. Guard CUA `isValidGigaredPassword(password)`
     → `GrContractIdRequiredError` (mismo patrón que hoy con grClienteId).
  5. `email = seq > 0 ? deterministicTvEmail(input.lastName, grContratoId, seq) : input.email`.
- El resto del flujo (pool de CIC, register/activate/setInternalId, clearCancelled, reconcile +
  persistencia best-effort, evento) NO cambia. `internal_id` sigue = `currentTvInternalId(customerId, seq)`.
- `wantsPersist`: el contrato YA está validado arriba; la condición de persistencia se reduce a
  `!!this.csRepo && !!this.catalogRepo` (el `contractId` siempre está presente ahora).
- `CustomerLookup`: ya no necesita `grClienteId` para el alta. NO se quita del shape (otros use cases
  podrían usarlo); simplemente el alta deja de leerlo. `tvActivationSeq` se sigue leyendo (re-alta).

### 4. Infrastructure — adapter Prisma del lookup
Archivo: `src/infrastructure/http/app.ts` (`prismaContractOwnershipLookup`, L648-650).
```ts
function prismaContractOwnershipLookup(id) {
  return prisma.contract.findUnique({
    where: { id },
    select: { id: true, clientId: true, grContratoId: true },
  });
}
```
Una sola query (sin N+1). El tipo de retorno suma `grContratoId: string | null`.

### 5. Infrastructure — ruta register valida contractId requerido + mapea el error
Archivo: `src/infrastructure/http/routes/gigared.routes.ts`.

- En `POST /customers/:id/register` (L283-318): si `contractId` es ausente o `''` → responder
  `400 { error: 'contractId es obligatorio', code: 'VALIDATION_ERROR' }` ANTES de llamar al use case
  (mismo patrón que `/tv-password`, L330-332). Pasar `contractId` SIEMPRE al use case (ya no spread
  condicional).
- En `sendGigaredError`: agregar la rama
  `if (err instanceof GrContractIdRequiredError) { res.status(422).json({ error, code }); return true; }`
  e importar el error nuevo. (El `GrClientIdRequiredError` existente queda — ya no lo levanta el alta,
  pero no se borra el mapeo.)

## Migración
NINGUNA. `Contract.grContratoId` ya existe en el schema (`String? @unique`). No se toca SQL ni Prisma
schema.

## Permisos
NINGUNO nuevo. La ruta de alta ya está gateada con `tv.register` (`requireRegister`). El cambio no
agrega rutas ni acciones.

## Impacto en adapters
- Prisma: sólo `prismaContractOwnershipLookup` (suma `grContratoId` al select).
- In-memory (tests): el `contractLookup` de `gigared.routes.test.ts` (L126-129) y los helpers del
  test de use case deben devolver `grContratoId`. No hay un `InMemoryContractRepository` formal para
  este lookup — es un objeto literal inline en los tests.

## Plan de tests (strict TDD: red → green)

### Use case — `RegisterGigaredAccount.usecase.test.ts` (in-memory ports, NO mockear Prisma)
- El helper `contractLookup` in-memory pasa a devolver `{ id, clientId, grContratoId }`.
- Casos nuevos / modificados:
  1. alta deriva password de `grContratoId` (no de `grClienteId`): inyectar contrato con
     `grContratoId='204382'` y cliente con `grClienteId='999999'` → assert
     `port.register` recibe `password = 'ip204382' padded`.
  2. re-alta (cliente cancelado, seq=1) deriva email de `grContratoId`: assert `port.register`
     recibe `email = deterministicTvEmail(lastName, '204382', 1)`.
  3. contrato sin `grContratoId` (null) → `GrContractIdRequiredError` (code
     `GR_CONTRACT_ID_REQUIRED`), Gigared no tocado.
  4. `grContratoId` con chars fuera de CUA → `GrContractIdRequiredError`.
  5. contrato ajeno (`clientId` != customerId) → `ContractNotFoundError`, Gigared no tocado
     (validación SIEMPRE, no condicional).
  6. internal_id intacto: assert `setInternalId` con `currentTvInternalId(customerId, seq)`.
  - Ajustar los casos `#109` existentes: hoy llaman `execute('cust-1', minInput())` sin `contractId`.
    `minInput()` debe sumar `contractId` y el constructor debe recibir el `contractLookup` con
    `grContratoId`.

### Routes — `gigared.routes.test.ts` (supertest, repos in-memory)
- `contractLookup` in-memory suma `grContratoId` (default un valor CUA-válido, p.ej. `'204382'`).
- Casos nuevos:
  1. `POST /:id/register` sin `contractId` → 400 `VALIDATION_ERROR`.
  2. `POST /:id/register` con contrato sin `grContratoId` → 422 `GR_CONTRACT_ID_REQUIRED`.
  3. `POST /:id/register` con contrato ajeno → 404 `CONTRACT_NOT_FOUND`.
  4. happy path con `contractId` válido + `grContratoId` → 201.

## Riesgos
- **Medio**: cambiar `contractId` de opcional a requerido rompe cualquier caller del use case / ruta
  que hoy no mande contrato. Mitigación: la ruta valida y devuelve 400 claro; los tests `#109` se
  actualizan. Coordinar con FE (ver out-of-scope del proposal).
- **Bajo**: `grContratoId` podría venir `null` en contratos que no pasaron por GR sync. Cubierto por
  el 422 `GR_CONTRACT_ID_REQUIRED` (no se rompe, se informa).
- **Bajo**: el guard CUA sobre la password derivada del `grContratoId` reutiliza
  `isValidGigaredPassword`. Si los `grContratoId` reales tienen caracteres fuera de `[a-z0-9]`, el
  alta fallaría con 422 — verificar el formato real del `grContratoId` en prod antes del rollout
  (los de GR suelen ser numéricos → `ip{numerico}` es CUA-válido).
