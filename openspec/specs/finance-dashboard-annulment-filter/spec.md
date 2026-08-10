# Spec — `finance-dashboard-annulment-filter`

**Capability**: `finance-dashboard-annulment-filter` (NEW)
**Change**: `gr-receipt-annulment`
**Summary**: Los cuatro lectores de recibos que alimentan el dashboard de Finanzas (`BuildFinanceMonthlySnapshot`,
`ComputeCacAndPayback`) excluyen `anulado: true`, cerrando la deuda #7 aceptada en
`finance-growth-dashboard/proposal.md:164-168,178`. Sin este filtro, marcar `anulado` correctamente en el
ingest (capability `finance-growth`) no cambia nada en el dashboard: la plata anulada seguiría contando
para siempre.

## Purpose

`FinanceReceiptItemRepository.listByMonth`/`listByClientAndMonth` y
`FinanceReceiptApplicationRepository.listByMonth`/`listByClientAndMonth` (Prisma + sus gemelos in-memory)
son la única superficie que alimenta la caja cobrada, el `unclassifiedAmountArs`, y la atribución CAC/payback
del dashboard. Hoy filtran solo por `fechaRecibo`/`clientGrId`, sin tocar `anulado`.

## Requirements

### Requirement: FinanceReceiptItemRepository excludes annulled receipts

`PrismaFinanceReceiptItemRepository.listByMonth` y `.listByClientAndMonth` MUST agregar `receipt: {
anulado: false }` a su cláusula `where`, junto al filtro existente de `fechaRecibo` (y `clientGrId` para el
segundo). El gemelo `InMemoryFinanceReceiptItemRepository` MUST aplicar el mismo filtro.

#### Scenario: A voided receipt's items are excluded from the monthly cash total
- GIVEN un mes con un `FinancePaymentReceipt` `anulado: true` con items por $10.000 y otro `anulado: false`
  con items por $5.000
- WHEN `listByMonth` se consulta para ese mes
- THEN devuelve solo los items del recibo NO anulado ($5.000)

#### Scenario: A voided receipt's items are excluded from a single client's monthly total
- GIVEN un cliente con un recibo anulado y uno vigente en el mismo mes
- WHEN `listByClientAndMonth` se consulta
- THEN devuelve solo los items del recibo vigente

### Requirement: FinanceReceiptApplicationRepository excludes annulled receipts

`PrismaFinanceReceiptApplicationRepository.listByMonth` y `.listByClientAndMonth` MUST agregar `receipt: {
anulado: false }` a su cláusula `where`. El gemelo `InMemoryFinanceReceiptApplicationRepository` MUST
aplicar el mismo filtro.

#### Scenario: A voided receipt's applications are excluded from unclassifiedAmountArs
- GIVEN un recibo `anulado: true` con aplicaciones por $8.000
- WHEN `BuildFinanceMonthlySnapshot` computa `unclassifiedAmountArs` del mes vía `listByMonth`
- THEN esos $8.000 NO se cuentan

#### Scenario: A voided receipt's applications are excluded from CAC/payback attribution
- GIVEN un cliente con un recibo anulado aplicado a su contrato
- WHEN `ComputeCacAndPayback` consulta `listByClientAndMonth` para ese cliente/mes
- THEN el monto anulado no participa de la atribución de cobranza del contrato

### Requirement: The filter is idempotent-safe — no annulled money leaks through any of the four readers

Los cuatro métodos (`listByMonth`/`listByClientAndMonth` × Item/Application) MUST comportarse de forma
consistente: un recibo `anulado: true` NUNCA aparece en ninguno de los cuatro, sin excepción de camino
(mes actual, mes histórico, con o sin filtro de cliente).

#### Scenario: Revert-probe — removing the filter from any one reader turns its test red
- GIVEN el filtro `anulado: false` se retira de UNO de los cuatro métodos
- WHEN corre el test de regresión de ese método con un fixture que incluye un recibo anulado con monto
  distinto de cero
- THEN el test se pone en rojo (el monto anulado aparece en el resultado) — invariante sin test en el
  adapter real, no alcanza con testear el in-memory
