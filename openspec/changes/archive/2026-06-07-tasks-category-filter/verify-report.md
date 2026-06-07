# Verify report — tasks-category-filter (#12)

**Verdict: PASS**. Date: 2026-06-07. FE-only.

## Build & tests
- `tsc --noEmit` → exit 0.
- `npx vitest run` → **1876 passed, 0 failed**, 1 todo. El cambio no rompió ningún test.

## Spec compliance
| Requirement | Estado | Evidencia |
|---|---|---|
| REQ-CAT-1 — sin proyecto, 4 categorías + filtra | ✅ (código) | `StageMultiSelect` modo categoría: renderiza las 4 cuando `!workflowId`; `onCategoryChange` setea `filter.stageCategory`; el filtrado client-side ya existía. |
| REQ-CAT-2 — con proyecto, stages del workflow | ✅ | rama `!categoryMode` intacta. |
| REQ-CAT-3 — no mezclar modos | ✅ | el `<select>` de proyecto limpia `stageCategory` al elegir proyecto; "Todos" limpia `stageIds`. |
| REQ-CAT-4 — chip de categoría | ✅ | chip `Estado: {label}` con ×; "Limpiar todo" incluye `stageCategory: undefined`. |

## Notas
- Sin test unitario nuevo de `TaskFilterBar` (no existía; mockear ~6 hooks para una UI chica es bajo ROI). El filtrado por `stageCategory` ya está cubierto (existía); la UI se valida visual.
- Selección única de categoría (checkbox con toggle); se mantiene la forma single del filtro. Sin cambios de backend.
