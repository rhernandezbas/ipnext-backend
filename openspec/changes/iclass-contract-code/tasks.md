# Tasks — iclass-contract-code

## BE (strict TDD: red → green → refactor)

- [ ] T1. Test: `dispatchTaskToIClass` / `SendTaskToIClass` envía `contractCode` como customerCode cuando existe (seam: createdOrders[0].input.customerCode). Casos: con contrato, sin contrato (fallback), red.
- [ ] T2. Entidad `ScheduledTask.contractCode: string | null`.
- [ ] T3. In-memory repo: default `contractCode: null` (2 ramas) — seedTask ya soporta override.
- [ ] T4. Precedencia en `dispatchTaskToIClass.ts`: `task.contractCode ?? task.customerCode!` en path CUSTOMER.
- [ ] T5. Mapper Prisma `toTask`: INCLUDE.contract gana `grContratoId`; derivar `contractCode`.
- [ ] T6. DTO contrato: exponer `code` (= grContratoId). Entidad dominio Contract + mappers (PrismaCustomerRepository.toService, PrismaContractRepository.toContractListItem). Test del DTO.
- [ ] T7. `npx tsc --noEmit` verde.

## FE

- [ ] T8. Card del contrato (#42): badge mono con `code` si presente. Tipo del contrato gana `code`.

## Gates targeted

- [ ] BE: suites scheduling/iclass/contracts + tsc.
- [ ] FE: typecheck + suite tocada.
