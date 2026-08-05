# Archive — `gr-balance-refresh-lanes`

**EN PROD**: `db403f59` · run 30961217002 verde · 2026-08-04.

## Qué resolvió
El batch de balances excluía el estado GR 1 (Activo) por una premisa escrita como
comentario y **falsa**: medido en vivo, 33 de 40 activos tienen facturas con saldo.
⇒ **5.325 clientes activos nunca veían refrescadas sus facturas** y una factura ya
pagada les quedaba `pendiente` para siempre. El 97% de las llamadas se gastaba en Bajas.

Y de paso cerró un CRITICAL de **pérdida de datos** que encontró el review: un sobre
de error de GR (HTTP 200 + `{"error":"90"}`) se interpretaba como "no debe nada" y el
`upsertInvoices` replace-all **borraba todas las facturas del cliente**, con
`SyncState.lastResult = 'ok'` y el dashboard en verde.

## Verificado en vivo
```
[gr-balance] Estado 1: 5328 cliente(s) enumerado(s)
[gr-balance] Total únicos a refrescar: 5585
```
(el cálculo previo daba 5.582)

## Alcance RETIRADO tras el review (cards propias)
- Refresh on-demand del portal — carrera de replace-all concurrentes en la pantalla
  más caliente.
- Alarma de staleness del carril lento — falló DOS rondas de review seguidas.
- Fix del bot de IA — requiere rediseñar la frescura (`isBalanceStale` está
  cortocircuitado por status).

## Números del cierre
3 rondas × 3 revisores · 2 fix waves · 12.096 tests + `tsc` · 4 revert-probes, 4
mutantes muertos.

## Lección que quedó
El patrón `fix-wave-buscar-el-hermano` apareció **cuatro veces** en una sola sesión, y
**dos veces dos fixes de la misma wave se anularon entre sí** por darle significados
distintos al mismo `null`. La re-review focalizada no es ceremonia.
