<!-- generated from engram topic_key: sdd/tv-cancel-renew-cic/tasks -->
## BE (ipnext-backend)
- [x] Port: `GigaredPort.renewCic(internalId) → { oldCic, newCic }` (domain/ports/GigaredPort.ts)
- [x] Adapter: `GigaredClient.renewCic` → PUT `/accounts/{id}/renew?use_internal_id=true`, map `{old_cic,new_cic}`
- [x] DTO: `CancelTvResult` += `renew: {oldCic,newCic}|null`, `unlinked: boolean`
- [x] Use case: `CancelTv` — renew best-effort + `setInternalId(newCic, '')` unlink, después de packs/OTT/reconcile
- [x] Route: 207 si `failed || local==='failed' || renew===null || !unlinked`
- [x] Tests (TDD): use-case (renew/unlink ok+fail+orden), port witness, adapter renewCic, routes (200 + 207 renew-fail)
- [x] Fix port stubs en AddTvService/GigaredAccount usecase tests (renewCic)
- [x] `tsc --noEmit` limpio · jest targeted verde (124)

## FE (ipnext-frontend)
- [x] Tipo `CancelTvResult` += `renew`, `unlinked` (types/gigared.ts)
- [x] `cancelPartial` incluye `renew===null || !unlinked` (GigaredPanel.tsx)
- [x] Modal de resultado (no banner): "se estará deshabilitando en los próximos minutos" + pasos
- [x] 207 parcial → modal con pasos fallidos + Reintentar (idempotente)
- [x] Copy del confirm fuerte: renueva el CIC y lo desvincula ("como si no tuviera TV")
- [x] CSS `.cancelSteps`
- [x] Tests (Vitest) actualizados a modal + nuevos campos · `tsc --noEmit` limpio · 107 verde

## Notas
- `useCancelTv` ya invalidaba `accountKey`/`summary`/`all-accounts`/`client-contracts` → panel pasa a NO vinculado. Sin cambios.
- Permiso `tv.cancel` (#50) sin cambios.
