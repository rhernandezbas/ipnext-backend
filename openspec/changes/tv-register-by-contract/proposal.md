# tv-register-by-contract

## Why

Hoy el alta de una cuenta de TV (Gigared Play) deriva la identidad determinística del cliente —
el `grClienteId` (ID de Gestión Real del CLIENTE). Concretamente, en
`RegisterGigaredAccount.execute`:

- password = `deterministicTvPassword(customer.grClienteId)` → `ip{grClienteId}` padded (#65, #70).
- email (en re-alta, seq>0) = `deterministicTvEmail(lastName, customer.grClienteId, seq)` (#81).
- sin `customer.grClienteId` → `GrClientIdRequiredError` → 422 `GR_CLIENT_ID_REQUIRED`.

El usuario pidió mover el alta de TV al patrón "Contrato del cliente": **un cliente con N contratos
debe poder tener N identidades de TV distintas**. La fuente del ID GR pasa de ser el ID del CLIENTE
a ser el ID del CONTRATO de GR (`Contract.grContratoId`, único y estable, poblado siempre por el
GR sync). Es el mismo viraje conceptual que ya se aplicó en `iclass-contract-code` (#55), donde el
`customerCode` que viaja a IClass pasó a identificar al contrato y no al cliente.

Como el alta deja de colgar del cliente para colgar de un contrato concreto, **el contrato (y su
`grContratoId`) pasa a ser obligatorio** para registrar TV. Hoy `input.contractId` es OPCIONAL (solo
se usa para reconciliar el slot TV local y persistir credenciales); deja de ser opcional.

## What

1. **Cambiar la fuente del ID GR**: la identidad determinística de TV (password + email) se deriva
   del `grContratoId` del CONTRATO, no del `grClienteId` del cliente.
2. **Contrato requerido**: `contractId` pasa de opcional a requerido en el alta. El use case resuelve
   el contrato, valida ownership (sigue perteneciendo al cliente, ya existía) y lee su `grContratoId`.
3. **Error de dominio nuevo**: `GrContractIdRequiredError` (code `GR_CONTRACT_ID_REQUIRED`) → 422
   cuando el contrato no tiene `grContratoId` (no hay fuente para la identidad determinística).
   Sustituye, para el alta, al actual `GrClientIdRequiredError` (que queda intacto para el resto del
   flujo TV — change/credentials no se tocan).
4. **`ContractLookup` expone `grContratoId`**: la interfaz del port en `lookups.ts` y los dos adapters
   (Prisma `prismaContractOwnershipLookup`, in-memory de tests) suman `grContratoId: string | null`.

## Decisión de fuente: grContratoId del CONTRATO

`Contract.grContratoId String? @unique` (schema.prisma L228) ya es el código de contrato REAL del
negocio (GR), único y estable. El único path de creación de contratos es el GR sync
(`PrismaClientMirrorRepository.upsertContract`), que siempre lo setea — no hay creación manual de
contratos. Por eso NO se inventa una secuencia artificial: el dato de negocio ya existe (mismo
razonamiento que `iclass-contract-code`). **Sin cambio de schema → sin migración.**

## Decisión: contrato requerido

El alta de TV deja de ser "por cliente" y pasa a ser "por contrato". Sin un contrato no hay fuente
para la identidad determinística. Por lo tanto:

- La ruta `POST /api/gigared/customers/:id/register` valida que el body traiga `contractId`. Hoy lo
  acepta como opcional con strip silencioso → pasa a 400 `VALIDATION_ERROR` si falta (mismo patrón
  que `POST /:id/tv-password`, que ya exige `contractId` con 400 cuando viene vacío).
- El use case valida ownership del contrato ANTES de tocar Gigared (ya lo hacía para el reconcile),
  y ahora SIEMPRE (no solo cuando hay repos de persistencia). Un contrato ajeno/inexistente →
  `ContractNotFoundError` → 404, Gigared nunca se toca.
- Si el contrato existe y es del cliente pero no tiene `grContratoId` → `GrContractIdRequiredError`
  → 422, Gigared nunca se toca.

## Back-compat

- **Email secuencial (#81)**: la re-alta seguía generando el mail con
  `deterministicTvEmail(lastName, grId, seq)`. El `grId` ahora es el `grContratoId` del contrato en
  vez del `grClienteId` del cliente. El sufijo `seq` y el resto de la mecánica de re-alta (incrementar
  seq cuando el cliente está cancelado) NO cambian. El mail sigue siendo determinístico+recuperable y
  visible en Credenciales (#65).
- **password**: misma forma `ip{grId}` padded; cambia solo el `grId` que se le pasa.
- **internal_id**: `currentTvInternalId(clientId, seq)` sigue derivándose del Client.id + seq — NO
  cambia. El internal_id identifica al cliente en el partner; lo que cambia es la fuente del
  email/password determinísticos, no el internal_id.
- **Identidad de TV por cliente (#81)**: el contador `tvActivationSeq` sigue siendo por cliente. La
  identidad email pasa a tener componente de contrato (`grContratoId`) + seq, lo que naturalmente da
  identidades distintas por contrato.

## Scope

- BE solamente en esta planificación:
  - Dominio: error `GrContractIdRequiredError`.
  - Application: `ContractLookup.findById` expone `grContratoId`; `RegisterGigaredAccount` deriva la
    identidad del contrato + valida contrato requerido.
  - Infrastructure: `prismaContractOwnershipLookup` selecciona `grContratoId`; ruta gigared valida
    `contractId` requerido + mapea el error nuevo a 422.

## Out of scope / cambio coordinado aparte (FE)

- **FE — change coordinado separado**: el form de alta de TV. Según backlog #47b el alta de TV YA es
  por-contrato en el FE (el operador selecciona el contrato y el FE manda `contractId`). Hay que
  CONFIRMAR que el FE manda `contractId` SIEMPRE (no opcional) y que maneja el nuevo 422
  `GR_CONTRACT_ID_REQUIRED` con un mensaje claro ("el contrato no tiene ID de Gestión Real"). Si el
  FE hoy permite alta sin contrato, eso se ajusta en su propio change. Se documenta como follow-up FE,
  NO se toca acá.
- **No se tocan** los otros flujos TV (link, packs, ott, cancel, change-password, credentials). El
  `GrClientIdRequiredError` queda vivo para quien lo use; solo el alta deja de levantarlo.
- **Sin migración de schema** (`grContratoId` ya existe).
- **Permisos**: la ruta de alta ya está gateada con `tv.register` (`requireRegister`). NO hace falta
  permiso nuevo.
