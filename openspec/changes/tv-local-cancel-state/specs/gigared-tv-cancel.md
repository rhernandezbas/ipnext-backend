# Spec delta — gigared-tv-cancel (#72)

## MODIFIED Requirement: Baja TV completa

La baja de TV (`POST /api/gigared/customers/:id/cancel`) quita los packs del partner,
apaga el OTT, reconcilia el ítem TV local y registra el estado "sin TV" **localmente**
(el partner no ofrece desvinculación).

### Scenario: desmontaje completo
- WHEN todos los DELETE de packs salen OK (`failed.length === 0`)
- THEN se setea `Client.tvCancelledAt = now` y el result trae `localCancelled: true`
- AND `renewCic` se intenta best-effort para reciclar el cupo del pack base irremovible
- AND el router responde 200 (salvo que local/OTT/renew fallen → 207)

### Scenario: anti-acuñado de CICs (retry sobre baja ya hecha)
- WHEN el cliente ya tiene `tvCancelledAt` seteado
- THEN `CancelTv` lanza `TvNotLinkedError` (404 TV_NOT_LINKED) ANTES de llamar al partner
- AND NO se renueva el CIC (no se acuñan CICs nuevos)

### Scenario: desmontaje incompleto
- WHEN algún DELETE de pack falla (`failed.length > 0`)
- THEN NO se setea el flag (`localCancelled: false`) ni se renueva
- AND el router responde 207 → el retry re-procesa los packs pendientes

## REMOVED behavior: unlink en el partner
El paso `setInternalId(newCic, '')` se elimina: el partner rechaza el internal_id vacío
con HTTP 400 siempre. El campo `CancelTvResult.unlinked` se reemplaza por `localCancelled`.
