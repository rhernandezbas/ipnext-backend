# Archive Report — equipment-catalog

**Archivado**: 2026-06-03
**Artifact store**: hybrid (openspec + engram)
**Estado**: ✅ COMPLETO — desplegado en prod (BE + FE)

## Resumen ejecutivo

Convierte el enum hardcodeado de tipos de equipo (duplicado en 4 lugares) en un
**catálogo editable data-driven**, agrega la **sub-page de configuración** para
administrarlo, y registra **trazabilidad** del "revisado por inventario" (quién + cuándo).
Cierra 3 ítems del backlog 2026-06-03: #5, #6, #3. Planificado con SDD + agent team,
implementado en 6 batches con Strict TDD. Multi-repo coordinado, migraciones aditivas.

## Features entregadas

| Feature | Descripción | Estado |
|---------|-------------|--------|
| F1 (#5) | Catálogo `DeviceTypeCatalog` data-driven + validación dinámica (OCR/confirm/guards leen del catálogo; OTROS no-borrable; guard HTTP→422, use-case→OTROS) | ✅ prod |
| F2 (#6) | Sub-page `/admin/inventory/settings` → tab Equipos (ABM) + dropdowns dinámicos vía `useDeviceTypes` | ✅ prod |
| F3 (#3) | `reviewedByInventoryAt` + `reviewedByInventoryUserId` (FK RbacUser, SetNull); badge "✓ Revisado · {nombre} · {fecha}" | ✅ prod |

## Batches (Strict TDD)

| Batch | Fase | Commit BE | Tests |
|-------|------|-----------|-------|
| 1 | A+B dominio/adapters/use-cases/service | `466a3831` | 35 |
| 2 | C rutas + permiso RBAC | `b6e10656` | 36 |
| 3 | D validación dinámica (union→string) | `6fe5ed1e` | suite 2094 |
| 4 | E trazabilidad #3 | `6b4f95e4` | suite 2100 |
| 5 | F+G frontend | FE `5db88f4`+`13f6031` | vitest 1780 |
| 6 | H verificación | — | BE 2100 · FE 1780 verdes |

## PRs / Deploys
- Backend: PR #29 (ipnext-backend) → merged → deploy verde, 3 migraciones aplicadas.
- Frontend: PR #25 (ipnext-frontend) → merged → deploy verde.

## Migraciones aplicadas en prod (todas aditivas)
- `20260604050000_add_device_type_catalog` — tabla + seed idempotente de los 5 base (`ON CONFLICT (name) DO NOTHING`).
- `20260604060000_add_inventory_manage_permission` — RBAC idempotente, otorga `inventory.manage` a administrador + super_admin.
- `20260604070000_add_task_inventory_review_traceability` — 2 columnas nullable + FK a RbacUser.

## Decisiones de diseño clave (verificadas contra el código)
- FK de revisado → **RbacUser** (no Admin): `req.user.id` es RbacUser id; el path de inventario ya resuelve ahí.
- Seed de los 5 tipos **dentro de la migración** (no solo `seed.ts`): el deploy corre `migrate deploy` pero no `db seed`.
- **Cache singleton** (`DeviceTypeCatalogService`) invalidado desde la capa HTTP tras cada mutación: el hot path de confirmar inventario no toca la DB.
- OCR: nombres por **config provider**, sin cambiar la firma del port; degrada a los 5 base.
- Guard HTTP **estricto (422)** + use-case **indulgente (OTROS)**: estricto en la API humana, indulgente en el path automático de cierre.
- Permiso `inventory.manage` en **migración RBAC** + gateado en ambas capas (FE `Can`/`RequirePermission` dot + BE `requirePerm`).

## Source of truth actualizada
- `openspec/specs/equipment-catalog/spec.md` (capability nueva, copia directa de la delta — 36 requisitos RFC 2119).

## Engram (traceability)
- proposal: `sdd/equipment-catalog/proposal`
- spec: `sdd/equipment-catalog/spec`
- design: `sdd/equipment-catalog/design`
- tasks: `sdd/equipment-catalog/tasks`
- apply-progress: `sdd/equipment-catalog/apply-progress`
- apply-rules: `sdd/equipment-catalog/apply-rules`
- archive-report: `sdd/equipment-catalog/archive-report`

## Fuera de scope (pendiente, cambio aparte)
- **#1** — `CreateTaskModal`: proyecto sin default + obligatorio + descripción obligatoria.
- Mover los keywords de `classifyDeviceType` al catálogo.
- Migrar los enums lowercase sueltos de `InventoryItemsPage`/`Products`/`CpePage`.
