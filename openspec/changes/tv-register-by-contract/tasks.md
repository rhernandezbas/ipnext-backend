# Tasks — tv-register-by-contract

Orden STRICT TDD (red → green → refactor) por tarea, agrupado por fase.
La dirección de dependencias se respeta: domain → application → infrastructure → wiring → route.
NO implementar acá — esto es sólo el checklist para `sdd-apply`.

## Fase 1 — Domain (error de dominio)

- [ ] T1 (red→green). Error `GrContractIdRequiredError` (code `GR_CONTRACT_ID_REQUIRED`).
  - Archivo: `src/domain/errors/gigared.ts`.
  - Test: assertion de `code === 'GR_CONTRACT_ID_REQUIRED'` y `name` (puede ir junto al test del use
    case T4, o un test unitario mínimo del error). El error es puro dominio, sin deps externas.

## Fase 2 — Application (port + use case)

- [ ] T2 (red→green). `ContractLookup.findById` expone `grContratoId?: string | null`.
  - Archivo: `src/application/use-cases/gigared/lookups.ts`.
  - Test: se cubre indirectamente vía los tests del use case (T4); el cambio de interfaz habilita
    pasar `grContratoId` en el lookup in-memory.

- [ ] T3 (red). Tests del use case `RegisterGigaredAccount` — escribir PRIMERO los casos que fuerzan
    la nueva conducta (deben fallar contra el código actual).
  - Archivo: `src/__tests__/application/RegisterGigaredAccount.usecase.test.ts`.
  - El helper `contractLookup` in-memory devuelve `{ id, clientId, grContratoId }`; `minInput()` suma
    `contractId`; el constructor recibe el `contractLookup`.
  - Casos:
    1. alta deriva `password` de `grContratoId` (no de `grClienteId`).
    2. re-alta (cliente cancelado, seq=1) deriva `email` de `grContratoId`.
    3. contrato sin `grContratoId` (null) → `GrContractIdRequiredError`, Gigared no tocado.
    4. `grContratoId` no-CUA → `GrContractIdRequiredError`.
    5. contrato ajeno → `ContractNotFoundError`, Gigared no tocado (validación SIEMPRE).
    6. `internal_id` = `currentTvInternalId(customerId, seq)` intacto.
  - Ajustar los casos `#109` existentes para que pasen `contractId` + `contractLookup`.

- [ ] T4 (green). Implementar el cambio en `RegisterGigaredAccount`.
  - Archivo: `src/application/use-cases/gigared/RegisterGigaredAccount.ts`.
  - `input.contractId` requerido (string sin `?`).
  - Resolver+validar contrato (ownership) SIEMPRE, antes de Gigared → `ContractNotFoundError`.
  - Derivar `grContratoId`; `null`/no-CUA → `GrContractIdRequiredError`.
  - `password = deterministicTvPassword(grContratoId)`;
    `email = seq>0 ? deterministicTvEmail(lastName, grContratoId, seq) : input.email`.
  - `internal_id` y el resto del flujo intactos. `wantsPersist` se reduce a `!!csRepo && !!catalogRepo`.

## Fase 3 — Infrastructure (adapter Prisma del lookup)

- [ ] T5 (green). `prismaContractOwnershipLookup` selecciona `grContratoId`.
  - Archivo: `src/infrastructure/http/app.ts` (L648-650).
  - `select: { id: true, clientId: true, grContratoId: true }`; tipo de retorno suma `grContratoId`.
  - Sin test dedicado (es wiring Prisma); cubierto por el test de ruta supertest T7.

## Fase 4 — Route (validación + mapeo HTTP)

- [ ] T6 (red). Tests de ruta supertest — escribir PRIMERO.
  - Archivo: `src/__tests__/infrastructure/gigared.routes.test.ts`.
  - `contractLookup` in-memory suma `grContratoId` (default CUA-válido, p.ej. `'204382'`).
  - Casos:
    1. `POST /:id/register` sin `contractId` → 400 `VALIDATION_ERROR`.
    2. con contrato sin `grContratoId` → 422 `GR_CONTRACT_ID_REQUIRED`.
    3. con contrato ajeno → 404 `CONTRACT_NOT_FOUND`.
    4. happy path con `contractId` + `grContratoId` válido → 201.

- [ ] T7 (green). Ruta `POST /customers/:id/register` valida `contractId` requerido + mapea el error.
  - Archivo: `src/infrastructure/http/routes/gigared.routes.ts`.
  - `contractId` ausente/`''` → 400 `VALIDATION_ERROR` antes del use case; pasar `contractId` siempre.
  - `sendGigaredError`: rama `GrContractIdRequiredError → 422`; importar el error.

## Fase 5 — Gates

- [ ] T8. `npx tsc --noEmit` verde.
- [ ] T9. Suites afectadas verdes: `RegisterGigaredAccount.usecase.test.ts`, `gigared.routes.test.ts`,
    y el resto de suites gigared (regresión).

## Sin migración
`grContratoId` ya existe en `prisma/schema.prisma`. NO se toca SQL ni schema Prisma.

## Follow-up FE (cambio coordinado separado — NO en este change)
- Confirmar que el form de alta de TV manda `contractId` SIEMPRE y maneja el 422
  `GR_CONTRACT_ID_REQUIRED` con mensaje claro. Backlog #47b indica que el alta ya es por-contrato en
  el FE; verificar que no permita alta sin contrato.
