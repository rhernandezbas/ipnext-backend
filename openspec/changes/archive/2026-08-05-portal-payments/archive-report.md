# Archive — `portal-payments`

**EN PROD**: `ab98d707` · run 30985011124 verde · 2026-08-05.

## Qué resolvió
Cuando un cliente pagaba, **el pago no dejaba ningún rastro**: GR saca la factura
pagada de `cuentas.invoices` y el `upsertInvoices` replace-all borra la fila (solo 2
facturas en estado `pagada` sobre 7.588). La app mostraba únicamente lo que el cliente
DEBE.

La fuente es el RECIBO, no deducir sobre la factura ausente: que una factura
desaparezca **no significa "pagada"** — pudo ser anulada o cancelada con nota de
crédito, y una AUSENCIA no discrimina entre causas.

## Verificado en vivo
```json
{ "date": "2026-08-03T03:00:00.000Z",
  "amounts": [{ "currency": "ARS", "amount": 2500.01 }],
  "method": "mercadopago",
  "appliedTo": [{ "invoiceNumber": "000080104", "amount": 2500.01 }] }
```
Ese `invoiceNumber` es **la factura que el replace-all había borrado**.

**La premisa de la que colgaba todo, medida**: `Client.grClienteId` y
`FinancePaymentReceipt.clientGrId` los llenan parsers DISTINTOS de GR y la tabla
estaba vacía ⇒ si diferían en un carácter, todos veían lista vacía con 200 OK y la
suite en verde. Post-backfill: **402 recibos, 402 matchean, 0 huérfanos**.

## Lo que el review corrigió
El código de prod estaba bien; falló la **red de seguridad**: el test anti-IDOR del
spec no existía (un regex de texto que se esquiva con un alias local ⇒ IDOR con 57/57
en verde) y el composition test miraba una ventana 72× más grande que el bloque que
decía vigilar. Más dos bugs de datos reales: el pago 100% retención salía **sin
importe** (medido: los 2 recibos con retenciones de 1.500 NO traen items) y el orden
podía **duplicar una fila en dos páginas y perder otra**.

## Pendiente
La pantalla "Mis pagos" en `ipnext-customer-app` — contrato ya cerrado y verificado.
