# Spec (delta) — `portal-payments`

## PAY-1 — `GET /api/portal/payments` lista los pagos del cliente DEL TOKEN

### PAY-1.1 — Anclaje al token, sin excepción
El `clientId` sale SIEMPRE de `req.portalClientId`; el `grClienteId` se DERIVA de esa
fila. Ningún identificador del request participa de la consulta.

- **Escenario**: request con `?clientId=` de otro cliente ⇒ se ignora.
- **Escenario**: cliente sin `grClienteId` ⇒ 200 con lista vacía (no 500, no 404).

### PAY-1.2 — La forma de cada pago
Cada elemento DEBE exponer: `date` (fecha del recibo, ISO), `amount`, `currency`
(ISO normalizado), `method` (el recaudador de GR) y `appliedTo[]` — a qué facturas
se aplicó, con `invoiceNumber` y `amount`.

- **Por qué `appliedTo`**: es lo que reconstruye el vínculo que el espejo pierde. La
  factura pagada se BORRA de `Invoice` (replace-all), así que la única forma de
  decirle al cliente *"esto pagó la factura 000080104"* es la aplicación del recibo.
- **Anclado en el payload REAL** (verificado en vivo, pago del usuario del 03-08):
  `recaudador: "mercadopago"`, `items[].importe: "2500.01"`, `moneda: "PES"`,
  `aplicaciones[]: {tipo:"FB", sucursal:"00010", numero:"000080104"}`.

### PAY-1.3 — El importe es el CASH recibido, no la deuda cancelada
`amount` DEBE salir de los **items** (el dinero que efectivamente entró), NO de las
aplicaciones.

- **Por qué**: `aplicaciones` es deuda CANCELADA y puede EXCEDER el cash cuando el
  recibo trae retenciones (identidad medida en el módulo de finanzas:
  `SUM(aplicaciones) - SUM(items) - SUM(retenciones) = 0`). Decirle al cliente que
  pagó más de lo que pagó es mentirle sobre su plata.

### PAY-1.4 — Multi-moneda: NO se suma
Si un recibo tiene items en más de una moneda, sus importes NO se suman en un solo
número.

- **Por qué**: misma regla que obligó a `balances[]` por moneda en `/me`. Sumar pesos
  con dólares da un número sin sentido económico.

### PAY-1.5 — Los recibos ANULADOS no se muestran
Un recibo con `anulado = true` NO DEBE aparecer.

- **Por qué**: mostrarle al cliente un pago que se anuló es peor que no mostrar nada.
- **Nota**: el parser de `GestionRealClient` ya excluye las anulaciones REALES antes
  de persistir; la columna es auditoría. El filtro es defensa en profundidad, y el
  **servidor es la autoridad** (no se delega en el filtro del ingest).

### PAY-1.6 — Orden y paginado
Orden por fecha DESC (lo más reciente primero), con el mismo contrato paginado que
el resto del portal (`{data, total, page, limit}`).

## PAY-2 — El endpoint no puede filtrar datos de otro cliente

### PAY-2.1 — El filtro vive en el WHERE del adapter
El anclaje por `grClienteId` DEBE estar en la query del adapter Prisma, no solo en el
use case.

- **Contra-escenario (revert-probe)**: si se saca el filtro del WHERE, un test DEBE
  ponerse en rojo.
- **Por qué**: lección `invariante-sin-test-en-el-adapter-real` — los 5 filtros que
  impiden que un cliente vea datos de otro estaban testeados solo en el gemelo
  in-memory; borrarlos del Prisma real dejaba la suite entera en verde.

## ING-1 — Prender la ingesta de recibos

### ING-1.1 — Piso del backfill a 3 meses
`FinanceReceiptSyncConfig.backfillFloorYearMonth` pasa a `2026-05` y `enabled` a
`true`.

- **Por qué NO el piso actual (`2013-01`)**: medido en vivo, GR no tiene recibos
  antes de ~2021 ⇒ caminaría años vacíos gastando requests.
- **Es config de RUNTIME, no código**: el scheduler re-lee `enabled` en cada tick, así
  que se prende sin deploy y se apaga igual si molesta.
- **Volumen esperado**: ~15.000 recibos, ~150 páginas, ~50 min de backfill pausado
  (20 s entre requests, y el carril delta tiene prioridad ABSOLUTA sobre el backfill).
