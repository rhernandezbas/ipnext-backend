# Change: tv-cancel-renew-completes (#74)

## Intent
La baja de TV reporta "parcial · OTT sigue activo" (HTTP 207) aunque el renew del CIC fue exitoso. El renew ES la baja efectiva: cambia el CIC, deja el login/mail del CUA viejo muerto y resetea la cuenta. El flag `ottDisabled` se evalúa ANTES del renew sobre el CIC VIEJO, por lo que cuando ese paso falla marca un falso parcial pese a que el renew posterior dejó la cuenta inutilizable.

## Evidencia LIVE (2026-06-12, prod read-only)
Caso real `0006717800` → `0006283226` (`ssh + docker exec ipnext-new-backend`, `GET /accounts/{cic}`):
- CIC NUEVO `0006283226`: HTTP 200, `ott.status=null`, `email=null`, `qty_registered_devices=0`, internal_id reasignado. Cuenta FRESCA/reiniciada por el renew.
- CIC VIEJO `0006717800`: HTTP 403 `cic-ownership-error` "El revendedor no posee esta cuenta". El renew desvinculó el CIC viejo del revendedor.

Conclusión: el `ottDisabled=false` era irrelevante. El renew dejó la cuenta vieja muerta (403) y la nueva reseteada (ott null). El 207 fue un falso parcial.

## Scope
- BE: criterio 207 en el router de cancel (`gigared.routes.ts`) — el `!ottDisabled` deja de contar cuando el renew tuvo éxito.
- FE: alinear `cancelPartial` con el router + ajustar el copy del modal (no mostrar "OTT sigue activo" como problema cuando renew OK; añadir línea "cuenta reiniciada"). Completar el tipo `CancelTvResult` que no modelaba `renew`/`renewAttempted`/`localCancelled`.

## Out of scope (NO TOCAR)
- `tvCancelledAt` (#72) — el desmontaje completo lo sigue seteando.
- reconcile / credenciales (#65/#67).
- El use case `CancelTv` no cambia su shape: ya devuelve `renew` y `renewAttempted`.

## Approach
Reemplazar el predicado `!ottDisabled` (aislado) por `(!ottDisabled && !renewSucceeded)` donde `renewSucceeded = renewAttempted && renew !== null`. El renew fallido sigue dando 207 vía `(renewAttempted && renew === null)`.
