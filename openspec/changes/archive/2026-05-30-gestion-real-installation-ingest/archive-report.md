# Archive Report: gestion-real-installation-ingest

**Change**: gestion-real-installation-ingest
**Date Archived**: 2026-05-30
**Artifact Store**: openspec
**Archive Path**: `openspec/changes/archive/2026-05-30-gestion-real-installation-ingest/`

---

## SDD Cycle

Motor de ingesta periódica de órdenes de instalación (`tipo == "CI"`) desde Gestión Real. Resuelve
links locales cliente/servicio, clasifica la tecnología (FIBER ≥100Mbps / WIRELESS <100 /
UNCLASSIFIED) parseando la velocidad de bajada del plan, y crea un `ScheduledTask` idempotente por
orden (`grOrdenId` UNIQUE NULLABLE). Implementado con Strict TDD, verificado (PASS, 0 CRITICAL) y
deployado a producción.

## Phases Summary

| Phase | Status | Output |
|-------|--------|--------|
| propose | ✅ | Ingesta + clasificación + idempotencia + needs-review + config editable |
| spec | ✅ | NEW `gestion-real-ingest`, NEW `gestion-real-ingest-config`, DELTA `scheduling` |
| design | ✅ | Puerto `getServiceOrders`, GrLinkResolver, classifyTech, scheduler advisory-locked |
| tasks | ✅ | 47 tareas, Strict TDD |
| apply | ✅ | 47/47. Dominio + use-cases + adapters Prisma/InMemory + scheduler + rutas. ~84 tests nuevos |
| verify | ✅ | PASS — toda escena de spec con código + test; 0 CRITICAL, 0 WARNING; tsc net-new = 0 |
| archive | ✅ | Delta specs sincronizadas a main specs; change movido a archive |

## Estado final (deployed reality)

- **Feature flag `gestion-real-ingest` es el ÚNICO gate de activación en runtime** (REQ-SCHED-2).
  NO existe un `config.enabled` — el config sólo guarda tuning operativo (`intervalMs`,
  `fiberProjectId`, `wirelessProjectId`, `windowMonths`).
- **Fix C1**: una orden clasificada (FIBER/WIRELESS) cuyo proyecto destino NO está configurado
  (`fiberProjectId`/`wirelessProjectId` null) se crea como tarea **needs-review** (projectId null,
  prefijo `[REVISAR - Logística]`, contada como `unclassified`) — NO como tarea normal silenciosa
  (REQ-CREATE-4).

## Specs Synced

| Domain | Action | Details |
|--------|--------|---------|
| `gestion-real-ingest` | Created | Full new capability (REQ-SRC, FILTER, FK, TECH, CREATE-1..4, IDEMP, SCHED) |
| `gestion-real-ingest-config` | Created | Full new capability (REQ-CFG/GETCFG/PUTCFG/STATUS/REVIEW) |
| `scheduling` | Updated | +`grOrdenId` row en REQ-SHAPE-2; +2 ADDED reqs (grOrdenId idempotency key, task MAY have null project) absorbidas como sección "GR installation ingest integration" |

## Gaps conocidos (documentados, no bugs)

- Predicado de needs-review usa `grOrdenId IS NOT NULL AND projectId IS NULL` (más sólido que el
  match por título del wording original de REQ-REVIEW-1; equivalentes en la práctica). El spec
  sincronizado ya refleja el predicado implementado.
- Las tareas needs-review (proyecto null) caen al stage global 'Pendiente' / `defaultStageId`;
  requiere que exista un stage 'Pendiente' en prod.
