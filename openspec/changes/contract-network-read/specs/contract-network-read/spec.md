# Spec — contract-network-read (delta)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

**Decisiones LOCKED del proposal (no se reabren):**
- Nombres de campo EXACTOS acordados con el FE: `networkSiteId`, `networkSiteName`,
  `accessPointId`, `accessPointName`. Los 4 nullable.
- Aditivo puro: cero cambios de firma HTTP, cero endpoints nuevos, el PATCH no se toca.
- Anti-N+1: el join va en la MISMA query de `list()` (`include`), nunca una query por contrato.
- El in-memory double NO unifica sus dos stores (`items` vs `networkAssignments`) — fuera de scope.

---

## Capability: lectura del nodo/AP asignado en el listado de contratos

### Requirement: READ-1 — `ContractSummaryDto` expone la asignación actual
`ListContracts.execute()` MUST devolver, por cada contrato, `networkSiteId`, `networkSiteName`,
`accessPointId` y `accessPointName`. Cuando el contrato no tiene asignación, los 4 campos MUST ser
`null`. Cuando tiene asignación completa (nodo + AP), los 4 campos MUST reflejar el id y el `name`
joineado de `NetworkSite`/`AccessPoint`.

#### Scenario: contrato sin asignación
- Given un contrato sin `networkSiteId` ni `accessPointId`
- When se llama `ListContracts.execute()`
- Then el DTO trae `networkSiteId: null`, `networkSiteName: null`, `accessPointId: null`,
  `accessPointName: null`

#### Scenario: contrato con nodo + AP asignados
- Given un contrato con `networkSiteId = 'ns-1'` (nombre "Nodo Centro") y
  `accessPointId = 'ap-1'` (nombre "AP Torre Norte")
- When se llama `ListContracts.execute()`
- Then el DTO trae `networkSiteId: 'ns-1'`, `networkSiteName: 'Nodo Centro'`,
  `accessPointId: 'ap-1'`, `accessPointName: 'AP Torre Norte'`

#### Scenario: asignación parcial (solo nodo, sin AP) — triangulación
- Given un contrato con `networkSiteId = 'ns-2'` (nombre "Nodo Sur") y `accessPointId = null`
- When se llama `ListContracts.execute()`
- Then el DTO trae `networkSiteId: 'ns-2'`, `networkSiteName: 'Nodo Sur'`,
  `accessPointId: null`, `accessPointName: null`

### Requirement: READ-2 — `PrismaContractRepository.list()` sin N+1
La query de `list()` MUST incluir las relaciones `networkSite` (`select: { name: true }`) y
`accessPoint` (`select: { name: true }`) en el MISMO `findMany` que ya trae `client` — MUST NO
haber una query adicional por contrato.

#### Scenario: un solo round-trip con las 3 relaciones
- Given cualquier `query` de listado
- When se llama `PrismaContractRepository.list(query)`
- Then `prisma.contract.findMany` se invoca EXACTAMENTE una vez y su `include` contiene
  `client`, `networkSite` y `accessPoint`

#### Scenario: mapeo null-safe de relaciones ausentes
- Given una fila con `networkSite: null` y `accessPoint: null` (contrato sin asignar)
- When se mapea a `ContractListItem`
- Then `networkSiteId`, `networkSiteName`, `accessPointId`, `accessPointName` son todos `null`
  (sin throw)

### Requirement: READ-3 — equivalente in-memory
`InMemoryContractRepository.seed()` MUST aceptar `networkSiteId`, `networkSiteName`,
`accessPointId`, `accessPointName` opcionales y `InMemoryContractRepository.list()` MUST
devolverlos tal cual fueron seedeados (default `null` los 4 si se omiten).

#### Scenario: round-trip seed → list
- Given `repo.seed({ ..., networkSiteId: 'ns-9', networkSiteName: 'Nodo Oeste', accessPointId:
  'ap-9', accessPointName: 'AP Loma' })`
- When se llama `repo.list(...)`
- Then la fila devuelta trae los 4 campos con esos valores exactos

### Requirement: READ-4 — cero breaking en consumidores existentes
Los campos nuevos MUST ser puramente aditivos: ningún consumidor existente de `ContractSummaryDto`
MUST cambiar de comportamiento. En particular, `toExternalContractDto` (API externa,
`externalV1.routes.ts`) MUST seguir usando su allow-list explícito y MUST NO filtrar los 4 campos
nuevos hacia afuera.

#### Scenario: la API externa no expone los campos nuevos
- Given un `ContractSummaryDto` con `networkSiteId`/`accessPointId` poblados
- When se proyecta con `toExternalContractDto`
- Then el resultado NO tiene las keys `networkSiteId`, `networkSiteName`, `accessPointId` ni
  `accessPointName`
