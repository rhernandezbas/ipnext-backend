# Proposal — `portal-payments`

## Problema

**Cuando un cliente paga, el pago no deja rastro en Prominense.**

GR no devuelve la factura pagada con `saldo: 0` — la **saca** de `cuentas.invoices`. Y
`upsertInvoices` es replace-all, así que la fila **se borra**. Medido en prod
(2026-08-05, cuenta del usuario):

```
filas de la factura pagada (FB-00010-000080104):  0
recibos espejados en FinancePaymentReceipt:       0
facturas en estado 'pagada':                      2   (de 7.588)
```

La app le muestra al cliente **solo lo que debe**. Lo que pagó es invisible.

Lo detectó el usuario mirando el fix de `gr-balance-refresh-lanes`: *"deberías
persistir la factura pagada también"*.

## Por qué NO se resuelve marcando la factura como `pagada`

Que una factura desaparezca de GR **no significa "pagada"**: significa "ya no está
pendiente". Pudo ser pagada, **anulada**, o cancelada con una nota de crédito.
Marcarla `pagada` por deducción es inferir una causa específica desde una
**AUSENCIA**, que no discrimina entre causas — y acá es sobre plata, de cara al
cliente.

El **recibo** es evidencia POSITIVA. Payload real de GR para el pago del usuario
(verificado en vivo, es el diseño de este change):

```json
{ "fecha_recibo": "03-08-2026",
  "recaudador": "mercadopago",
  "observaciones": "Pago desde la WEB de Clientes con MercadoPago",
  "items":        { "196973": { "tipo":"transf", "importe":"2500.01", "moneda":"PES" } },
  "aplicaciones": { "567959": { "importe":"2500.01", "tipo":"FB",
                                "sucursal":"00010", "numero":"000080104" } } }
```

La `aplicacion` apunta a **la factura que el espejo borró** ⇒ el recibo no solo
prueba el pago: **reconstruye el vínculo que hoy se pierde**.

## Lo que YA existe (y está apagado)

La maquinaria de ingesta está escrita, testeada y cableada en `main.ts`:
`FinancePaymentReceipt` + `FinanceReceiptItem` + `FinanceReceiptApplication` +
`FinanceReceiptRetencion`, `SyncGrReceiptsDelta`, `SyncGrReceiptsBackfillBatch` y
`FinanceReceiptIngestScheduler` (un solo scheduler arbitra los dos carriles, delta
con prioridad ABSOLUTA, 20 s entre requests).

Está **apagada**: `FinanceReceiptSyncConfig.enabled = false` desde 2026-07-27, tabla
en 0 filas. El `enabled` es un kill-switch de RUNTIME (se re-lee en cada tick), así
que prenderlo no requiere deploy.

## Volumen medido (2026-08-05, contra GR en vivo)

| Mes | Recibos |
|---|---:|
| jul 2026 | 5.162 |
| ene 2026 | 3.448 |
| ene 2025 | 5.265 |
| ene 2021 | 4.680 |
| ene 2020 | **0** |

⇒ ~5.000 recibos/mes, con data desde ~2021. **El piso configurado hoy (`2013-01`)
caminaría años VACÍOS al pedo.**

| Alcance | Recibos | Backfill (100/pág × 20 s) |
|---|---:|---:|
| **3 meses** ← elegido | ~15.000 | **~50 min** |
| 12 meses | ~60.000 | ~3,3 h |
| todo (2021) | ~330.000 | ~18 h |

## Propuesta (decisiones del usuario, 2026-08-05)

1. **Prender la ingesta con piso a 3 meses** (`backfillFloorYearMonth = 2026-05`).
   Arrancar chico: el pago del usuario (03-08) entra, y el piso se puede bajar
   después sin perder nada — el backfill sigue caminando hacia atrás solo.
2. **`GET /api/portal/payments`**: fecha, importe, moneda, medio de pago y **a qué
   factura se aplicó**, anclado al cliente DEL TOKEN.
3. **BE primero.** La pantalla "Mis pagos" en `ipnext-customer-app` va como change
   coordinado DESPUÉS, con el contrato ya cerrado y verificado en vivo contra el
   pago real del usuario — el workflow lo pide así justamente porque un contrato
   definido sobre un endpoint que nunca vio datos reales driftea sin que ningún
   test lo cace.

## Fuera de alcance

- La pantalla de la app (change coordinado posterior).
- Marcar la factura como saldada cruzándola contra las `aplicaciones` — posible más
  adelante y por EVIDENCIA, no por deducción; no hace falta para "Mis pagos".
- Bajar el piso del backfill más allá de 3 meses (decisión aparte, sin código).
