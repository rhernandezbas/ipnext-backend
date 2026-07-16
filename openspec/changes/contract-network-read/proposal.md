# Proposal — contract-network-read (BE, chico y aditivo)

## 1. Why / Intent

`contract-node-ap-catalog` (Fase A) y `contract-node-ap-auto-assign` (Fase B) ya están en prod:
`Contract.networkSiteId` / `Contract.accessPointId` se pueblan por el auto-assign (flag DARK) y por
el picker manual (`PATCH /contracts/:id/network-assignment`, `SetContractNetworkAssignment`).

Pero el DTO que consume el FE para listar contratos (`GET /api/contracts` → `ListContracts` →
`ContractSummaryDto`) **nunca leyó esos campos**. Solo el PATCH los devuelve (como eco de lo que
acaba de escribir). El picker manual de Fase B — planificado como change de FE aparte — necesita
saber qué nodo/AP tiene asignado un contrato AL ABRIRSE, y hoy no tiene de dónde leerlo sin un
segundo endpoint. El picker está, literalmente, ciego a lo ya asignado.

## 2. Scope IN

1. **`ContractSummaryDto`** (`src/application/dto/contract.dto.ts`) — 4 campos nuevos, TODOS
   nullable: `networkSiteId`, `networkSiteName`, `accessPointId`, `accessPointName`. Contrato
   acordado con el FE — nombres exactos, sin variantes.
2. **`ContractListItem`** (`src/domain/ports/ContractRepository.ts`) — mismos 4 campos, port-level,
   para que `ListContracts` pueda mapearlos sin acoplarse a Prisma.
3. **`ListContracts.execute()`** — pass-through de los 4 campos del repo al DTO.
4. **`PrismaContractRepository.list()`** — INCLUYE las relaciones `networkSite` y `accessPoint`
   (`select: { name: true }`) en la MISMA query que ya trae `client` (anti-N+1: un solo
   round-trip, jamás una query por contrato).
5. **`InMemoryContractRepository`** — equivalente de test: `seed()` acepta y devuelve los 4 campos
   nuevos vía `list()`.
6. Sin asignación ⇒ los 4 campos en `null` (el FE lo renderiza como "Sin asignar").

## 3. Scope OUT (explícito)

- **El PATCH `/contracts/:id/network-assignment`** — ya funciona (Fase B), no se toca ni su firma
  ni su comportamiento.
- **El picker manual del FE** — change coordinado aparte en `ipnext-frontend`; este change solo
  desbloquea la lectura que ese picker necesita.
- **Sincronizar el in-memory double entre `updateNetworkAssignment` y `list()`** — el doble
  in-memory usa hoy dos stores separados (`items` para `list()`, `networkAssignments` para el
  PATCH), un split pre-existente de Fase B. Este change NO lo unifica (fuera de scope, evita tocar
  tests del PATCH que ya pasan); el `seed()` extendido alcanza para testear el lado de lectura.
- **Ningún endpoint nuevo** — cero cambios de firma HTTP, cero rutas nuevas. Aditivo puro sobre un
  DTO existente.

## 4. Enfoque

Aditivo y de bajo riesgo: 4 campos nullable en un DTO ya en prod, poblados desde relaciones que ya
existen en el schema (`Contract.networkSite` / `Contract.accessPointId`, ambos con FK desde Fase A).
Ningún consumidor existente del DTO se rompe — `toExternalContractDto` (API externa) usa un
allow-list explícito y future-field-safe, así que los campos nuevos no se filtran ahí. Riesgo
principal: N+1 si el `include` de Prisma se arma mal — mitigado con un test de adapter (mocked
Prisma) que pinea que `findMany` se llama UNA sola vez con las 3 relaciones (`client`,
`networkSite`, `accessPoint`) en el mismo `include`.
