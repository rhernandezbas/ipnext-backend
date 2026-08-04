# Proposal — `gr-balance-refresh-lanes`

## Problema

Una factura pagada en Gestión Real queda `pendiente` en Prominense **para siempre**, y la app
de clientes se la muestra al cliente que acaba de pagarla.

`RefreshDebtorBalances` enumera SOLO los estados GR `['2','3','4','6']` (Deudor, Inactivo,
Incobrable, Baja). El **estado 1 (Activo) está excluido a propósito**, con esta afirmación
escrita como comentario en el código:

> "NUNCA se agrega el estado 1 (Activo): verificado en vivo que siempre devuelve cero
> facturas, así que enumerarlo solo desperdiciaría llamadas GR."

**La premisa es falsa.** Medido en vivo contra GR el 2026-08-04: en una muestra aleatoria de
40 clientes estado=1, **33 (82,5%) tienen facturas con saldo**.

La premisa se coló porque `clientes_consulta` —el endpoint de ENUMERAR— **no devuelve ningún
campo de deuda** (verificado); el que sí lo devuelve es `cliente`, que es el que el código
realmente llama para el balance. Se verificó con un endpoint y se concluyó sobre otro.

## Radio de impacto (medido, no estimado)

| Estado GR | Clientes | ¿Lo refresca el batch hoy? |
|---|---:|---|
| **Activo (1)** | **5.325** | **NO** |
| Deudor (2) | 69 | sí |
| Inactivo (3) | 188 | sí |
| Incobrable (4) | 0 | sí |
| Baja (6) | 9.082 | sí |

- **El 97% del presupuesto de llamadas (9.082/9.339) se gasta en BAJAS**; 0% en los activos,
  que son los únicos que usan la app de clientes.
- Espejo local: **504 clientes con facturas** llevan >2 h sin refresh (311 llevan >7 días), y
  de ellos cuelgan **820 facturas impagas**.
- Spot-check de 13 clientes stale contra GR: **8 desactualizados, todos `Activo`**. Incluye a
  `RAVELLO NORMA BEATRIZ` (107906), que **pagó todo** (GR: saldo 0) y Prominense le mostraba
  $21.999 impagos.

## Problema de capacidad descubierto de paso

Latencia GR medida: **0,459 s/llamada**.

| Escenario | Llamadas | Duración | Ventana (60 min) |
|---|---:|---:|---|
| Hoy | 9.339 | ~71 min | ❌ ya se pasa |
| Sumar activos a secas | 14.664 | ~112 min | ❌ mucho peor |
| Carril rápido (1+2+3+4) | 5.582 | ~43 min | ✅ entra cómodo |
| Carril lento (6), 1×/día | 9.082 | ~70 min | ✅ de madrugada |

El batch **ya hoy** excede su intervalo y el guard `inFlight` le hace saltear ticks en
silencio. Sumar los activos sin redistribuir empeoraría un problema preexistente.

## Qué NO está roto (probado en vivo antes de codear)

Se disparó el refresh on-demand que ya existe (`GET /api/clients/:id` →
`RefreshClientBalanceIfStale`) contra la cuenta del usuario en prod:

```
balanceDue: 130061.29 -> 127561.28   (idéntico a GR)
7 facturas -> 6.  La factura pagada se borró sola.
```

⇒ `upsertInvoices` (replace-all), `mapGrInvoice` y `deriveInvoiceStatus` están **bien**.
GR no devuelve la factura pagada con saldo 0: **la saca de la lista**, y el `deleteMany` la
limpia. **El único bug es a quién se enumera.**

## Propuesta

1. **Dos carriles de refresh** (decisión del usuario):
   - **Rápido**, cada hora: estados `1,2,3,4` — 5.582 llamadas, ~43 min.
   - **Lento**, 1×/día en la madrugada AR: estado `6` (Bajas) — 9.082 llamadas.

   Mismo volumen total de llamadas a GR, pero la data fresca va a quien la mira. De paso
   **arregla el overrun de ventana que ya existe hoy**.

2. **Refresh on-demand en el portal** (decisión del usuario): `GET /api/portal/invoices`
   dispara `RefreshClientBalanceIfStale` igual que ya hace `GetClientDetail` en el panel
   (TTL 60 min, timeout corto, si GR falla sirve lo guardado). El cliente que acaba de pagar
   ve la verdad al instante, sin esperar al batch.

3. **Corregir el comentario falso** y dejar registrado cómo se refutó.

## Fuera de alcance

- Tocar `mapGrInvoice` / `deriveInvoiceStatus` / `upsertInvoices` — probados correctos en vivo.
- Reemplazar la enumeración por estado GR con una consulta al espejo local (opción evaluada y
  descartada por el usuario: es un rediseño del use case, no un ajuste).
- Los `pdfUrl` / `paymentUrl` que apuntan a infraestructura de GR (deuda ya registrada).
