# Design — `portal-payments`

## Decisión 1 — Puerto de LECTURA nuevo, separado del de ingesta

`FinancePaymentReceiptRepository` (el que ya existe) es de ESCRITURA: `upsertBatch` +
`exists`. Sumarle una lectura cliente-facing lo convierte en un puerto con dos
públicos y dos razones de cambio.

⇒ puerto nuevo `PortalPaymentsReader`, con una sola operación:
`listByGrClienteId(grClienteId, {page, limit})`. Molde:
`PrismaClientMirrorReadRepository`, que ya existe por la misma razón.

## Decisión 2 — El JOIN se hace en la DB, no en memoria

Cada pago necesita el recibo + sus items (importe) + sus aplicaciones (a qué factura).
Se resuelve con un `include` de Prisma en UNA query paginada, no con N+1.

`FinancePaymentReceipt` ya tiene `@@index([clientGrId])` y `@@index([clientGrId, fechaRecibo])`
— el índice compuesto que el módulo de finanzas agregó ya cubre exactamente este acceso
(filtrar por cliente, ordenar por fecha).

## Decisión 3 — El importe se calcula en el DOMINIO, no en el adapter

Sumar los items por moneda es una regla de negocio (PAY-1.3 / PAY-1.4), no una
consulta. Vive en una función PURA que se testea sin DB:

```ts
sumarItemsPorMoneda(items) -> Array<{currency, amount}>
```

Así el "no sumar monedas distintas" queda cubierto por tests de tabla, y el adapter
solo trae filas.

## Decisión 4 — `anulado` se filtra en el WHERE del adapter

No en el use case. El ingest ya excluye las anulaciones reales antes de persistir,
pero **el servidor es la autoridad**: si mañana el criterio del ingest cambia, el
endpoint cliente-facing no puede empezar a mostrar pagos anulados en silencio.
Con revert-probe (PAY-2.1).

## Decisión 5 — Prender la ingesta es CONFIG, no deploy

`FinanceReceiptSyncConfig` es un singleton en DB y el scheduler re-lee `enabled` en
cada tick (kill-switch de runtime, decisión ya tomada en `finance-growth`). ⇒ el
cambio de `enabled`/`backfillFloorYearMonth` es un UPDATE, se hace DESPUÉS del deploy
del endpoint y se puede revertir sin tocar código.

**Orden deliberado**: primero el código (inerte, la tabla está vacía), después la
perilla. Al revés tendríamos datos entrando sin nada que los lea.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El backfill presiona a GR justo cuando el carril rápido de balances corre 43 min de cada hora | Son schedulers distintos con presupuestos propios; el de recibos espacia 20 s entre requests y el delta tiene prioridad. Se mide en vivo tras prender y se apaga con el flag si molesta. |
| El cliente ve un pago aplicado a una factura que ya no existe en el espejo | Es lo DESEADO: el `appliedTo` es justamente el vínculo que el replace-all borra. Se muestra el número de factura, no un link a una fila. |
| Un recibo con items en varias monedas | No se suman (PAY-1.4); se exponen por moneda. |

## Sin migración de base de datos
Las cuatro tablas de recibos ya existen y están vacías.
