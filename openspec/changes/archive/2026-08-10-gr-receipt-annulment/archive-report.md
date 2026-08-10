# Archive Report: gr-receipt-annulment

**Change**: gr-receipt-annulment
**Date Archived**: 2026-08-10
**Artifact Store**: openspec (filesystem)
**Archive Path**: openspec/changes/archive/2026-08-10-gr-receipt-annulment/
**Deploy SHA**: `81b3a019`
**Branch**: `fix/gr-receipt-annulment`, verify HEAD `bb558602`

## SDD Cycle Complete

Proposal → spec → design → tasks → apply (2 fix waves) → verify (PASS, 0 CRITICAL) → archive.

## Capabilities Touched

| Capability | Action | Details |
|------------|--------|---------|
| `finance-dashboard-annulment-filter` | Created (NEW) | `openspec/specs/finance-dashboard-annulment-filter/spec.md` — 3 requirements, 5 scenarios, straight copy from the delta (no prior canonical spec existed). |
| `portal-payments` | Modified | `openspec/specs/portal-payments/spec.md` — PAY-1.5 rewritten: the filter moved from "defense in depth over a column that always read false" to "first real line of defense" now that the ingest actually populates `anulado: true`. |
| `finance-growth` | Modified (see special case below) | Applied against the PENDING spec of `finance-growth-dashboard`, not a canonical spec. |

## ⚠️ Special Case — `finance-growth` delta target

The `finance-growth` delta spec's own header states its target is
`openspec/changes/finance-growth-dashboard/specs/finance-growth/spec.md` — the change
`finance-growth-dashboard` has **not archived yet**, so no canonical
`openspec/specs/finance-growth/spec.md` exists. Per the delta's own documented fallback
("si el orden se invierte, sdd-archive debe aplicar este delta contra
`openspec/specs/finance-growth/spec.md` una vez exista"), and per this archive run's explicit
instruction, the two MODIFIED requirements ("Global incremental receipt ingest…" and "Receipt ingest
pacing…") were rewritten in place, and the five ADDED requirements (reconcile lane, snapshot-rebuild
queueing on annulment, one-way latch, format-tolerant `isRealAnnulment`, systemic annulment-ratio guard)
were inserted — all applied directly onto
`openspec/changes/finance-growth-dashboard/specs/finance-growth/spec.md`, which is still a PENDING
(unarchived) artifact. That file now reflects the receipt-annulment behavior consistently, ready for
whenever `finance-growth-dashboard` itself archives — at that point its own `sdd-archive` run will copy
this already-updated pending spec straight to the canonical `openspec/specs/finance-growth/spec.md`
with no further merge needed for these requirements.

## Problem and Fix

The proposal's original framing ("an annulled receipt stays visible") **could not be confirmed live** —
0 annulments found across 2,821 receipts / 3 GR probes on 2026-08-10. The annulment fix therefore ships as
**defensive** (never validated against a real case, only against fixtures + revert-probes). The **actual
active bug found during investigation** was worse and confirmed in prod: `SyncGrReceiptsDelta` collapses its
cursor to a flat `fechaHasta`, re-scanning only ~1 day of overlap — any receipt whose GR clearing
(`fecha_confirmacion`) lands later than that overlap (SIRO, PagoFácil, débito automático) is lost from the
mirror **permanently**. Measured on 05-08-2026: GR had 299 receipts, the mirror had 197 — **102 missing
(34.1%)**, all confirmed 1-3 days after `fecha_recibo`.

Fix, five pieces: (1) a third `reconcile` lane in `FinanceReceiptIngestScheduler` (priority delta > reconcile
> backfill) that re-sweeps a rolling window (default 35 days — sized to be ≥ the nightly snapshot rebuild's
`[mes anterior, mes corriente]` horizon) and re-upserts every receipt in it; (2) the parser stops skipping
annulled receipts before the mapper (`GestionRealClient.ts` `continue` removed, `mapGrReceipt.ts` derives
`anulado` from `isRealAnnulment` instead of hardcoding `false`); (3) the four dashboard readers
(`FinanceReceiptItemRepository`/`FinanceReceiptApplicationRepository` × `listByMonth`/`listByClientAndMonth`)
add `receipt: { anulado: false }`, closing debt #7 accepted in `finance-growth-dashboard`; (4) operational
catch-up of the historical gap using existing endpoints (`rearm-backfill` + `backfill-snapshots`), zero new
code; (5) `isRealAnnulment` hardened from fail-open to a per-row fail-closed with a systemic ratio guard
(aborts a page — writes nothing — if annulled ratio exceeds `annulmentGuardMaxPct` AND absolute count reaches
`annulmentGuardMinCount`, catching sentinel-format drift without volcado-masivo risk).

Two requirements were added mid-apply (fix-wave-1) beyond the original proposal: annulment-triggered
snapshot-rebuild queueing for closed months (the "≠ mes corriente" rule, replacing an initial "outside the
nightly horizon" rule that raced two different clocks across month boundaries), and the annulled flag as a
one-way latch (GR blanking `fecha_anulacion` never un-annuls the mirror; reversal is a human SQL action).

## Live Verification (post-deploy, prod)

- **299/299** recibos del 05-08-2026 presentes en el espejo, incluyendo los **102 recuperados** por el
  catch-up operacional (`rearm-backfill` + `backfill-snapshots`, `2026-05..2026-08`).
- **Sweep reconcile**: 6.587 items procesados sin fallos.
- **Backfill catch-up**: 33.735 recibos re-barridos, idempotentes por `grReceiptId`.
- **Snapshots** `2026-05` a `2026-08`: recomputados sin fallos.
- Gate: `tsc --noEmit` limpio, suite completa 1208 passed / 6 skipped de 1214 suites, 12408 passed / 88
  skipped de 12496 tests, 0 failed.

## Review Rounds (2 fix waves)

1. **fix-wave-1** — agregó los dos requirements de rebuild-queueing y one-way latch a `finance-growth`
   (RF3/RFX1: reemplazó el criterio "fuera del horizonte nocturno" por "≠ mes corriente" tras encontrar una
   carrera de dos relojes en el borde de mes que dejaba ~21 h de ventana ciega por mes en silencio).
2. **fix-wave-2 (RFX3)** — el streak de guard-aborts pasó de parsearse de un marcador `guardAborts=N` en
   `lastResult` (vulnerable a resetearse con cualquier error intercalado, haciendo el umbral de abandono
   inalcanzable) a estado PERSISTIDO explícito en `SyncState`.

## Verify Report Findings

**Veredicto: PASS.** 37/37 scenarios reales (contra el texto actual de las 3 specs tocadas, post fix-waves)
tienen test identificado y verde — la matriz del apéndice de `tasks.md` estaba corta (21→29 en
`finance-growth`, faltaban los 8 scenarios de los dos requirements agregados por fix-wave-1; los 8 SÍ tenían
test). Cero CRITICAL, cero desvío documentado deja a una spec pidiendo algo no implementado.

## Deliberate Out-of-Scope

- No tocar la ventana de solapamiento del carril delta (sigue siendo el carril de baja latencia).
- Sin campos nuevos en `PortalPaymentDto` (`id`, `status`) — aditivo, coordinado con `ipnext-customer-app`
  si se necesita más adelante.
- Sin revertir/borrar `FinanceReceiptApplication` de un recibo anulado — excluidas por el filtro del padre,
  borrarlas destruiría auditoría.
- Sin tercer estado `pending`/`unconfirmed` — 0 desaparecidos medidos, sin evidencia positiva no se modela.
- Sin tocar el manejo del sobre de error de GR ni el guard de identidad `aplicaciones = items + retenciones`.
