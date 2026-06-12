<!-- generated from engram topic_key: sdd/tv-cancel-renew-cic/proposal -->
## Intent
Extender la baja de TV (#47k `CancelTv`) para que, además de quitar packs + apagar OTT +
inactivar el ítem local, **RENUEVE el CIC** y **desvincule** el `internal_id` del cliente, de
modo que el cliente quede "como si no tuviera TV" (panel NO vinculado). El FE muestra un **modal**
asíncrono: "La TV se estará deshabilitando en los próximos minutos." (#64).

## Why
- Pedido textual: "al darle de baja sería RENOVAR CIC (actualmente solo desactiva la tv) y
  tendría que eliminar los datos de la tv, y debería aparecer como si no tuviera. Al darle, que
  salga un modal que la tv se estará deshabilitando en los próximos minutos."
- Hoy `CancelTv` deja el `internal_id` ligado a la cuenta → `getAccountByInternalId(customerId)`
  sigue devolviendo 200 → el panel sigue mostrando "vinculado". No alcanza con desactivar.

## Hallazgo clave (arquitectura)
NO existe un dato LOCAL que ate Client↔CIC. El vínculo vive 100% en Gigared como
`account.internal_id == customerId` (seteado por `setInternalId(cic, customerId)`). El único dato
TV local es el `ContractService` (notes "CIC …") que el reconcile ya inactiva.
`GetGigaredCustomerAccount` computa `linked = (getAccountByInternalId(customerId) responde 200)`.
→ Para que el cliente aparezca NO vinculado hay que limpiar el `internal_id` en Gigared sobre el
**nuevo CIC** tras el renew. La premisa del diseño original ("limpiar internal_id local") no aplica:
no hay link local que limpiar.

## Cambio propuesto
1. **Port** `GigaredPort.renewCic(internalId) → { oldCic, newCic }` (PUT `/accounts/{id}/renew?use_internal_id=true`).
2. **Adapter** `GigaredClient.renewCic` (mapea `{old_cic,new_cic}` → camelCase). `setInternalId` ya existe; se reutiliza con `''` para desvincular.
3. **Use case** `CancelTv` (mismo use case, sin nuevas deps): tras packs+OTT+reconcile, best-effort
   `renewCic(customerId)` y luego `setInternalId(newCic, '')`. Si renew falla → `renew=null`, no se
   intenta unlink. Si unlink falla → `unlinked=false`. Nunca aborta el lote.
4. **DTO** `CancelTvResult` += `renew: {oldCic,newCic}|null`, `unlinked: boolean`.
5. **Route** POST `/customers/:id/cancel`: 207 si cualquier paso falló (DELETE, local, renew o unlink).
6. **FE**: modal de resultado (no banner) "La TV se estará deshabilitando en los próximos minutos."
   con detalle de pasos (packs/OTT/ítem/CIC). 207 parcial → modal con pasos fallidos + Reintentar
   (idempotente). `useCancelTv` ya invalida `accountKey`, `summary`, `all-accounts` (lección #61) y
   `client-contracts` → el panel pasa a NO vinculado.

## Orden de pasos (pinned)
guards → remove packs (por servicio, independientes) → OTT off (idempotente) → reconcile local →
**renew CIC** → **unlink (setInternalId(newCic, ''))**.

## Riesgos
- `tv.md` no documenta si `PATCH /internal_id` acepta vacío. El unlink es best-effort: si el
  partner lo rechaza, queda paso `unlink` fallido en 207 (renew ya hecho). El CIC nuevo conserva
  nuestro internal_id en el partner pero localmente queda libre; una re-vinculación futura lo pisa
  con `LinkCustomerToCic` (PATCH internal_id).
- Permiso sin cambios: `tv.cancel` (#50).

## Rollback
Quitar los pasos renew+unlink del use case y los campos `renew`/`unlinked` del DTO/tipos FE.
