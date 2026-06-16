# Capability: pppoe-inventory

Inventario persistente de servicios PPPoE (`cliente → contrato → pppoe → router`) y su carga inicial one-off desde los routers MikroTik cruzada con GR.

## ADDED Requirements

### Requirement: Modelo PppoeService

El sistema SHALL persistir cada servicio PPPoE como una fila `PppoeService` con `username` (único), `password`, `profile`, `remoteAddress` (nullable), `status`, `nasId` (router, requerido), `contractId` (nullable), `matchMethod` e `importedAt`.

#### Scenario: PPPoE vinculado a un contrato
- **WHEN** se carga un secret que matchea un contrato de GR
- **THEN** la fila tiene `contractId` poblado y `matchMethod` ∈ {`username`, `fuzzy`, `manual`}

#### Scenario: PPPoE huérfano (sin contrato)
- **WHEN** se carga un secret que no matchea ningún cliente de GR (p.ej. Agote/Gowland)
- **THEN** la fila se persiste igual con `contractId = null` y `matchMethod = orphan`

#### Scenario: username único
- **WHEN** ya existe un `PppoeService` con un `username`
- **THEN** una segunda carga del mismo `username` actualiza la fila existente, no crea otra

#### Scenario: cliente con múltiples contratos
- **WHEN** un cliente tiene más de un contrato y más de un PPPoE
- **THEN** el sistema permite N filas `PppoeService` para ese cliente (una por `username`), cada una con su `contractId`

### Requirement: Repositorio idempotente

El sistema SHALL exponer un `PppoeServiceRepository` (port de dominio) con upsert por `username`, y consultas `list`, `findByUsername`, `findByContract`.

#### Scenario: upsert idempotente
- **WHEN** se hace upsert de un `username` que ya existe
- **THEN** se actualizan los campos (no se duplica) y la cantidad total no cambia

#### Scenario: listar por contrato
- **WHEN** se consulta `findByContract(contractId)`
- **THEN** se devuelven todas las filas PPPoE de ese contrato

### Requirement: Matching en cascada (función pura)

El sistema SHALL resolver el contrato de cada secret con una cascada determinista: (1) username exacto normalizado contra el `pppoeUsername` del CSV de GR; (2) si no hay match, fuzzy por nombre con umbral conservador; (3) si no hay candidato único, huérfano.

#### Scenario: match exacto por username
- **WHEN** `normalize(secret.name)` == `normalize(csv.pppoeUsername)`
- **THEN** se vincula ese contrato con `matchMethod = username`

#### Scenario: fallback fuzzy con candidato único
- **WHEN** no hay match exacto por username pero el nombre normalizado matchea un único cliente sobre el umbral
- **THEN** se vincula con `matchMethod = fuzzy`

#### Scenario: ambiguo no se auto-resuelve
- **WHEN** el fuzzy arroja más de un candidato sobre el umbral (o multi-contrato indistinguible)
- **THEN** NO se vincula automáticamente; la fila va al bucket `ambiguous` del reporte para revisión manual

#### Scenario: sin candidato → huérfano
- **WHEN** no hay match por username ni fuzzy
- **THEN** la fila se carga como `orphan` (`contractId = null`)

#### Scenario: normalización estable
- **WHEN** se normalizan dos strings que difieren solo en mayúsculas, acentos, espacios o signos
- **THEN** producen la misma clave normalizada

### Requirement: Import best-effort por router (one-off)

El script de import SHALL procesar cada router de forma independiente y resiliente, sin abortar el lote si uno falla, y emitir un reporte con los buckets de resultado.

#### Scenario: un router caído no aborta el lote
- **WHEN** un router no responde o falla la conexión
- **THEN** el script registra el error de ese router y continúa con los demás

#### Scenario: reporte de resultado
- **WHEN** termina el import
- **THEN** emite un reporte con conteos por bucket: `matched-username`, `matched-fuzzy`, `orphan` (con sub-conteo de los esperados Agote/Gowland) y `ambiguous`

#### Scenario: throttle entre routers
- **WHEN** el script pasa de un router al siguiente
- **THEN** respeta un delay configurable para no saturar los maestros
