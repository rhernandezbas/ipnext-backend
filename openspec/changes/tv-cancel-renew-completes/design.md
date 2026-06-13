# Design: tv-cancel-renew-completes (#74)

## Decisión del arquitecto

El use case `CancelTv` NO cambia: su shape ya incluye `renew` y `renewAttempted`. El bug vive en el **criterio del veredicto**, que está duplicado en dos lugares (router BE + `cancelPartial` FE) y desalineado entre sí. El fix:

1. Reemplazar el predicado `!ottDisabled` (aislado) por `(!ottDisabled && !renewSucceeded)`.
2. Alinear el FE con el router (el FE ni siquiera chequeaba `renew`).

### Por qué el OTT deja de contar con renew OK
El paso OTT corre ANTES del renew, sobre el CIC VIEJO. El renew genera un CIC nuevo, desvincula el viejo del revendedor (403 cic-ownership) y resetea la cuenta (`ott.status=null`). Por lo tanto, cuando el renew tuvo éxito, el estado del OTT viejo es **moot**: el login viejo está muerto y no hay streaming posible. Mantener `!ottDisabled` en el veredicto produce un falso 207.

### Por qué el OTT SIGUE contando cuando el renew NO reseteó
Si el renew no se intentó (`renewAttempted=false`) o falló (`renew=null`), la cuenta original sigue viva. Ahí un OTT no apagado SÍ significa streaming activo → parcial real. El renew fallido ya da 207 por su propio término `(renewAttempted && renew===null)`; el `!ottDisabled` aporta el caso "nada que renovar + OTT activo" (`renewAttempted=false`).

## Tabla de verdad

`renewSucceeded = renewAttempted && renew !== null`

| # | failed | local | ottDisabled | renewAttempted | renew | Veredicto | Razón |
|---|--------|-------|-------------|----------------|-------|-----------|-------|
| 1 | 0 | synced | true  | true  | obj  | **200** | caso feliz |
| 2 | 0 | synced | false | true  | obj  | **200** ← FIX | OTT viejo moot, renew reseteó (caso #74) |
| 3 | 0 | synced | true  | true  | null | **207** | renew intentado y falló |
| 4 | 0 | synced | false | true  | null | **207** | renew falló + OTT no apagado = cuenta vieja viva |
| 5 | 0 | synced | false | false | null | **207** | nada que renovar pero OTT viejo activo = parcial real |
| 6 | 0 | synced | true  | false | null | **200** | cuenta ya pelada |
| 7 | >0 | * | * | * | * | **207** | pack falló (renew bloqueado por guard #64) |
| 8 | 0 | failed | * | * | * | **207** | reconcile local falló |

Único caso que cambia: **#2** (207 → 200).

## Criterio final (idéntico BE router y FE)
```ts
const renewSucceeded = result.renewAttempted && result.renew !== null;
const partial =
  result.failed.length > 0 ||
  result.local === 'failed' ||
  (result.renewAttempted && result.renew === null) ||
  (!result.ottDisabled && !renewSucceeded);
```

## Cambios FE
- `src/types/gigared.ts` `CancelTvResult`: agregar `renew: { oldCic; newCic } | null`, `renewAttempted: boolean`, `localCancelled: boolean` (el BE ya los devuelve; el tipo estaba incompleto).
- `GigaredPanel.tsx` `cancelPartial`: usar el criterio final (alinear con router).
- Copy: cuando `renewSucceeded`, el banner de ÉXITO (200) menciona "Cuenta reiniciada (CIC nuevo) — el acceso anterior queda invalidado". El banner parcial reporta el paso OTT como pendiente SOLO cuando `!renewSucceeded`.

## Out of scope
- `tvCancelledAt` (#72), reconcile/credenciales (#65/#67) — intactos.

## Riesgos
- Wire contract: el status code de cancel pasa de 207→200 en el caso #2. Consumidores que distingan 200/207 deben tratar 200 como éxito (es la semántica correcta). No hay otros consumidores del endpoint además del FE.
- El FE ahora depende de `renew`/`renewAttempted` en la respuesta — ya presentes en el BE desde #64.
