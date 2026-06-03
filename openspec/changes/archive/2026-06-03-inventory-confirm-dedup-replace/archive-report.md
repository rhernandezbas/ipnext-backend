# Archive Report — inventory-confirm-dedup-replace

**Archivado**: 2026-06-03 · **Store**: hybrid · **Estado**: ✅ en prod (BE PR#36 + FE PR#29)

## Resumen
Refinamiento del inventario: convierte el match (de `inventory-edit-and-match`) de aviso visual en **acción** al confirmar un equipo. Modo automático, Strict TDD, 1 migración aditiva.

## Comportamiento
- **same_device** (SN/MAC ya instalado): confirmar con `add` → **409 `DUPLICATE_INSTALLED_ITEM`** (frena el duplicado); `link_existing` → vincula la sugerencia al ítem existente, no crea.
- **same_type** (SN nuevo): `add` (coexisten) o **`replace`** (ruta nueva `POST .../replace` gated `inventory.write`): retira la actual (`status='replaced'`) + crea la nueva con `replacesItemId`.
- **sin match**: confirmar normal.

## Capas
- F1 matcher extraído a `src/application/services/matchInstalledItem.ts` (puro, compartido por List + Confirm); filtro `status==='active'`.
- F2 `ConfirmInventorySuggestion` gana `resolution` + método `replace()`. Errores `DuplicateInstalledItemError`, `NoReplaceTargetError` (409).
- F3 `ContractInstalledItem.replacesItemId` self-relation (migración `20260604110000`, aditiva).
- F4 confirm zod enum `add|link_existing` (replace→400); ruta `replace` gated `inventory.write` (perms.contractWrite ya cableado).
- F5 FE: `SuggestionCard` botones por match; `useReplaceSuggestion`; degrada si no hay match.

## Decisiones
- Match por SN/MAC = aparato físico. `replace` gated `inventory.write`. `replacesItemId` self-relation (historial). Atomicidad: retire→create (nunca duplicado activo). El confirm es operator-driven → el 409 no rompe ningún cron (el cierre solo crea pending).

## Verificación
BE 2270 jest + tsc limpio · FE 1849 vitest. BE PR#36 + FE PR#29, deploy verde.

## Source of truth
`openspec/specs/inventory-confirm-dedup-replace/spec.md` (23 reqs).

## Fuera de scope
Reemplazo ambiguo con múltiples del mismo tipo (v1 reemplaza el matcheado), replace de materiales, deshacer reemplazo, `$transaction` en el port (deuda).
