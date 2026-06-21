# Archive Report — recapture-admin-assign (BE)

**Fecha:** 2026-06-20
**Estado:** ✅ COMPLETO Y EN PRODUCCIÓN
**Repo:** ipnext-backend

## Qué se entregó
Recaptación pasa de "el agente auto-toma leads" a "el ADMIN asigna":
- **Permiso nuevo `recapture.assign`** (admin) — seed + migración idempotente `20260804000000_recapture_assign_permission`, grant a super_admin/administrador.
- **`PATCH /leads/assign-bulk`** (bulk) gateado `assign`; `ingest`/`import-csv`/`assign` single re-gateados a `assign`.
- **Restricción server-side por ownership**: el agente (read+manage, sin assign) ve y gestiona SOLO sus leads (`GET /leads` scopeado a su `assigneeId`; GET/PATCH/contacts con guard `lead.assigneeId === actorId` → 404).
- **Self-take eliminado**: `claim-next`, `claim`, `release` (rutas + use cases) borrados.
- Sin migración de schema (`assigneeId` ya existía).

## Pipeline SDD aplicado
- proposal + design + spec + tasks + verify-report.
- **verify** (tsc + jest, corrido por el orquestador): limpio + 4964/0.
- **sdd-verify**: PASS (24 scenarios, 21 directos).
- **review adversarial (4 focos)** → cazó **2 CRITICAL** que el verify dio por verdes:
  1. `portfolio /by-vendedor` + `/all` gateados con `manage` → el agente (que ahora tiene manage) podía leer carteras ajenas. **FIX**: re-gate a `assign`.
  2. `gr-vendedor-mappings` (GET+PATCH) con read/manage → el agente podía leer/editar mapeos ajenos. **FIX**: re-gate a `assign`.
  + fail-closed en `hasRecaptureAssign` y `GET /leads`.
- **re-review focalizado de los fixes**: CLEAN.
- gate final integrado (tras rebase): tsc limpio + 5030/0.

## Commits / Deploy
- Commit `99038a9e` → deploy verde (migración del permiso aplicada en prod).

## Notas
- Cambio bajo SDD formal + review adversarial obligatorio (reglas del 2026-06-20). El review adversarial demostró su valor: 2 leaks de datos cross-agent cazados antes de prod.
- El FE (repo ipnext-frontend, change hermano) se desplegó inmediatamente después para cerrar la ventana de incompatibilidad (el FE viejo usaba claim-next/claim/release).
