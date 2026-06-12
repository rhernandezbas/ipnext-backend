# Design — iclass-contract-code

## Contexto del seam (explorado)

- `dispatchTaskToIClass.ts` L118-120: path CUSTOMER → `effectiveCustomerCode = task.customerCode!`. Path NETWORK usa `networkSite.iclassNodeCode`. Este es el ÚNICO punto donde se decide qué identidad viaja.
- `task.customerCode` (entidad `ScheduledTask`) se deriva en `PrismaSchedulingRepository.toTask` de `row.customer.grClienteId ?? splynxId ?? login`.
- `INCLUDE.contract` ya existe en el repo Prisma (`contract: { select: { id: true } }`) — solo falta pedir `grContratoId`.
- `Contract.grContratoId String? @unique` — código GR real, siempre poblado (GR sync es el único creador).
- IClassClient arma `customer: { customerCode, name, mobile }` inline — el código es libre.

## Cambios

### 1. Dominio — `ScheduledTask.contractCode`
Nuevo campo `contractCode: string | null` en `src/domain/entities/scheduling.ts`. Comentario: "Código del contrato (Contract.grContratoId). Cuando existe, viaja a IClass como customerCode en lugar del código de cliente — el cliente IClass se identifica por contrato (#55)."

### 2. Mapper Prisma — `toTask`
- `INCLUDE.contract` → `{ select: { id: true, grContratoId: true } }`.
- `const contractCode = row.contract?.grContratoId ?? null;` → agregar al objeto retornado.

### 3. In-memory repo
- `NEW_FIELDS_DEFAULTS.contractCode: null` y la otra rama (L347). `seedTask` ya hace spread de overrides → permite `seedTask({ contractCode })`.

### 4. Precedencia en dispatch (corazón del cambio)
En `dispatchTaskToIClass.ts`, path CUSTOMER:
```ts
const effectiveCustomerCode = isNet
  ? (networkSite?.iclassNodeCode ?? NETWORK_CUSTOMER_CODE)
  : (task.contractCode ?? task.customerCode!);   // contrato precede al cliente
```
Fallback: sin contractCode → customerCode de cliente (back-compat). Si NO hay ni contractCode ni customerCode, el `!` revienta igual que hoy (precondición del caller).

### 5. DTO de contrato
`ContractSummaryDto` (o el que muestra la card #42) expone `code: string | null` ← `grContratoId`. Mapper Prisma del contrato lo incluye. Entidad de dominio Contract (`customer.ts`) gana `grContratoId` si es necesario para el mapper.

### 6. FE — badge
Card del contrato (#42): badge mono con `code` si está presente. Barato.

## Seam de tests (strict TDD)

- Use case real `SendTaskToIClass` + `InMemorySchedulingRepository.seedTask` + `InMemoryIClassClient`.
- Assertion: `iclass.createdOrders[0].input.customerCode`.
- Casos:
  1. tarea con `contractCode='CTR-204382'` + `customerCode='CLI-99'` → viaja `'CTR-204382'`.
  2. tarea con `contractCode=null` + `customerCode='CLI-99'` → viaja `'CLI-99'` (back-compat).
  3. tarea NETWORK → sin cambios, viaja `networkSite.iclassNodeCode`.

## Sin migración
`grContratoId` ya existe en schema. No se toca SQL.

## Riesgos
- Bajo. Cambio aditivo de campo + una línea de precedencia. Tareas sin contrato y de red intactas.
- IClass acumulará identidades cliente-viejo + contrato-nuevo en su historial (aceptado).
