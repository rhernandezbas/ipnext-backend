# Archive Report: iclass-closure-loop

**Change**: iclass-closure-loop
**Date Archived**: 2026-05-30
**Artifact Store**: hybrid (engram + openspec)
**Archive Path**: `openspec/changes/archive/2026-05-30-iclass-closure-loop/`

---

## SDD Cycle

Planificado a partir del research `iclass-closed-os-ingest` (también archivado hoy), implementado con Strict TDD, deployado a producción (BE + FE) y archivado. El alcance creció respecto del research por decisión del usuario: además de espejar las OS cerradas, **mueve la tarea local** al stage mapeado, y el mapping result-code→stage es **configurable desde la UX**.

## Phases Summary

| Phase | Status | Output |
|-------|--------|--------|
| explore/research | ✅ | `iclass-closed-os-ingest` — lifecycle, endpoints, gaps (fotos no expuestas, sin webhooks) |
| propose | ✅ | Polling + join codigo↔seq + mapping configurable + transición de tarea + backfill |
| spec | ✅ | NEW `iclass-closure-loop` (~11 REQ); DELTA `scheduling` |
| design | ✅ | AD-1..AD-8 (polling, join, mapping config, idempotencia, ids string, closedAt del history, sync vía tipoOs.id, backfill) |
| tasks | ✅ | 10 fases, Strict TDD |
| apply | ✅ | 6 tablas + dominio + use-cases + adapters + scheduler + rutas + FE. ~47 tests nuevos; suite total verde; tsc 0 |
| verify | ✅ | Parsers validados contra payloads REALES de IClass; flujo E2E cubierto por tests in-memory |
| archive | ✅ | Delta specs sincronizadas a main specs; change movido a archive |

## Deploys a producción

| Commit | Qué | Run |
|--------|-----|-----|
| `c3a86e6e` | backend closure loop (motor + 6 tablas + endpoints + flag) | 26643092642 ✅ |
| `75b98915` | backend endpoint backfill | 26644671990 ✅ |
| `9aa4be67` | fix: sync result-codes vía tipoOs.id | 26645554546 ✅ |
| `45677f0` (FE) | toggle "Cierre de OS" | 26643455256 ✅ |
| `be457c0` (FE) | subpage "Mapeo de resultados" | 26644743747 ✅ |
| `319184d` (FE) | botón "Reconciliar ahora" | 26644743747 ✅ |

## Estado operativo

Flag `iclass-closure-loop` arranca **OFF**. Activación: sincronizar result-codes → mapear cada uno a un Stage → prender el flag. El scheduler (10 min) y el botón de backfill cierran el loop.

## Gaps conocidos (documentados, no bugs)

- Fotos/firmas no expuestas por la API v2 de IClass → `photoMissing`. No scraping.
- El catálogo de result-codes solo surface tipos con OS en los últimos 28 días.
- Mapping ciudad→nodo (envío) sigue siendo match directo de nombre contra los nodos del tercero, sin mapping configurable (posible mejora futura).
