<!-- BE portion of the tv-action-errors change (FE is a sibling change in ipnext-frontend) -->
## Intent
Eliminar dos errores espurios en las acciones de TV/Gigared observados en uso real:
- **#1 (OTT)**: deshabilitar OTT devolvía "La cuenta OTT ya se encuentra deshabilitada" y el estado quedaba stale (había que salir/entrar).
- **#4 (vincular)**: vincular un CIC mostraba un 500 "error inesperado" aunque la acción SÍ se ejecutaba en Gigared.

## Causa raíz (verificada)
1. `GigaredClient.setOtt` solo trataba como idempotente el caso "ya se encuentra (des)habilitada" cuando llegaba como `GigaredRejectedError` (409). Pero el partner lo manda como **424 external-service-error**, que `mapError` mapea a `GigaredUnavailableError` → el guard no lo agarraba → el toggle "fallaba" pese a estar ya en el estado pedido.
2. Los 13 handlers de `gigared.routes.ts` usaban `if (!sendGigaredError(res, err)) next(err)`. Un error no tipado (ej. Prisma crudo del lookup de contrato, que ocurre DESPUÉS de que el vínculo ya se hizo en Gigared) caía al `errorHandler` global → 500 opaco sin cuerpo legible.

## Cambio
1. `setOtt`: el guard de idempotencia ahora también traga `GigaredUnavailableError` cuyo `detail` matchea `/ya se encuentra (des)?habilitada/i`. Cualquier otro error sigue propagando.
2. Helper `sendUnhandled(res, err, route)`: loguea `[gigared] <route>: unhandled` y responde **500 estructurado** `{ error, code: 'INTERNAL_ERROR' }`. Los 13 handlers lo usan en lugar de `next(err)`. El middleware `gigaredProbeReady` conserva `next(err)` (es pre-handler, correcto).

## Wire contract (lo consume el FE)
- Rutas gigared: ante error no reconocido → `500 { error: string, code: 'INTERNAL_ERROR' }` (antes: 500 opaco). El FE ya lee `errorDetail`/`errorCode`.

## Tests
- `GigaredClient.test`: 424→deshabilitada y 424→habilitada se tragan; 424 con otro detail (outage real) sigue tirando `GigaredUnavailableError`.
- `gigared.routes.test`: link con error no reconocido → 500 `{ code: 'INTERNAL_ERROR' }` + `console.error` con prefijo `[gigared]`.

## Rollback
Quitar la 2da rama del guard en `setOtt` y revertir los handlers a `next(err)` (restaurando el `errorHandler` global).
