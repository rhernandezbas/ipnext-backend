# Delta spec — gigared-tv (tv-register-by-contract)

## MODIFIED Requirement: fuente de la identidad determinística del alta de TV

Al registrar una cuenta de TV (`RegisterGigaredAccount`), la identidad determinística (password y
email) DEBE derivarse del `grContratoId` del CONTRATO indicado, NO del `grClienteId` del cliente.

- La password DEBE ser `deterministicTvPassword(contract.grContratoId)`.
- El email determinístico (re-alta, `seq > 0`) DEBE ser
  `deterministicTvEmail(lastName, contract.grContratoId, seq)`.

### Scenario: alta deriva la password del grContratoId del contrato
- GIVEN un cliente con `grClienteId = "999999"` y un contrato propio con `grContratoId = "204382"`
- WHEN se registra TV para ese cliente con ese `contractId`
- THEN la password enviada a Gigared es `deterministicTvPassword("204382")` (`ip204382` padded)
- AND NO se deriva nada del `grClienteId` del cliente

### Scenario: re-alta deriva el email del grContratoId del contrato
- GIVEN un cliente cancelado (re-alta, `seq` incrementa a 1) con un contrato cuyo `grContratoId = "204382"`
- WHEN se registra TV para ese cliente con ese `contractId`
- THEN el email enviado a Gigared es `deterministicTvEmail(lastName, "204382", 1)`
  (`{apellido}2043821@gmail.com`)

## MODIFIED Requirement: el contrato es obligatorio para el alta de TV

El alta de TV SHALL requerir un `contractId`. La ruta `POST /api/gigared/customers/:id/register`
DEBE rechazar con 400 `VALIDATION_ERROR` cuando el body no trae `contractId` (string no vacío). El
use case DEBE validar la propiedad del contrato (que pertenezca al cliente) ANTES de cualquier
escritura en Gigared.

### Scenario: alta sin contractId → 400 VALIDATION_ERROR
- GIVEN un request de alta de TV sin `contractId` (ausente o cadena vacía)
- WHEN se llama `POST /api/gigared/customers/:id/register`
- THEN la respuesta es 400 con `code = "VALIDATION_ERROR"`
- AND Gigared no se toca

### Scenario: contrato ajeno o inexistente → 404 CONTRACT_NOT_FOUND
- GIVEN un `contractId` que no existe o pertenece a OTRO cliente
- WHEN se registra TV para el cliente
- THEN se lanza `ContractNotFoundError` → 404 `CONTRACT_NOT_FOUND`
- AND Gigared no se toca (la validación de ownership precede a cualquier escritura)

## ADDED Requirement: error de dominio cuando el contrato no tiene grContratoId

Cuando el contrato indicado existe y pertenece al cliente pero su `grContratoId` es `null`/vacío, el
alta de TV SHALL fallar con un error de dominio `GrContractIdRequiredError` cuyo `code` es
`GR_CONTRACT_ID_REQUIRED`, mapeado por el router a HTTP 422. Gigared NO debe tocarse.

### Scenario: contrato sin grContratoId → 422 GR_CONTRACT_ID_REQUIRED
- GIVEN un contrato propio del cliente con `grContratoId = null`
- WHEN se registra TV para ese cliente con ese `contractId`
- THEN se lanza `GrContractIdRequiredError` con `code = "GR_CONTRACT_ID_REQUIRED"` → 422
- AND `register`, `activate` y `setInternalId` de Gigared no se invocan

### Scenario: grContratoId con caracteres fuera de la política CUA → 422 GR_CONTRACT_ID_REQUIRED
- GIVEN un contrato cuyo `grContratoId` produce una password que NO cumple `[a-z0-9]` (8..64)
- WHEN se registra TV
- THEN se lanza `GrContractIdRequiredError` → 422 (mismo guard CUA que hoy aplica al grClienteId)
- AND Gigared no se toca

## MODIFIED Requirement: ContractLookup expone grContratoId

El port `ContractLookup.findById` SHALL devolver `grContratoId: string | null` además de
`{ id, clientId }`, para que `RegisterGigaredAccount` derive la identidad determinística sin un
segundo lookup. El adapter Prisma (`prismaContractOwnershipLookup`) y el adapter in-memory de los
tests DEBEN incluir el campo.

### Scenario: el lookup Prisma selecciona grContratoId
- GIVEN un contrato persistido con `grContratoId = "204382"`
- WHEN `prismaContractOwnershipLookup(contractId)` resuelve
- THEN el resultado incluye `grContratoId = "204382"` junto a `id` y `clientId`

## ADDED Requirement: el internal_id sigue derivándose del cliente

El cambio de fuente del email/password NO altera el `internal_id`: SHALL seguir siendo
`currentTvInternalId(clientId, seq)` (Client.id + seq de reactivación). La identidad ante el partner
(internal_id) es por cliente; solo la identidad determinística email/password pasa a colgar del
contrato.

### Scenario: internal_id intacto tras el cambio de fuente
- GIVEN una primera alta (`seq = 0`) de un cliente `cust-1` con contrato `grContratoId = "204382"`
- WHEN se registra TV
- THEN `setInternalId` se invoca con `currentTvInternalId("cust-1", 0)` = `"cust-1"`
- AND la password viaja derivada de `"204382"` (contrato), no de `cust-1`
