# Archive Report — service-inventory-management

**Archivado**: 2026-06-03
**Artifact store**: hybrid (openspec + engram)
**Estado**: ✅ COMPLETO — desplegado en prod (BE PR#31 + FE PR#26)

## Resumen ejecutivo

Implementa el ítem #8 del backlog con el modelo de datos de **3 conceptos** confirmado por el usuario:
equipos (estado durable del contrato), catálogo de materiales (base de inventario), y consumo de
materiales por visita (ledger). Planificado con SDD + agent team y ejecutado en **modo automático**
(spec → design → tasks → 4 batches de apply → deploy coordinado), Strict TDD, migraciones aditivas.

## Features entregadas

| Feature | Descripción | Estado |
|---------|-------------|--------|
| F1 | CRUD de equipos del contrato + **quitar** (soft-delete idempotente: re-quitar = no-op, retorna el item); UpdateInstalledItem acepta cambiar el tipo (validado vs catálogo →422) | ✅ prod |
| F2 | `MaterialCatalog` (espeja DeviceTypeCatalog + `unit`): ABM en `/api/inventory/material-types` (read/manage) + tab "Materiales" en config | ✅ prod |
| F3 | `TaskMaterialConsumption` (ledger por tarea) + Record/List/Delete + rutas `/scheduling/:taskId/inventory/materials` (inventory.write); `ConfirmInventorySuggestion` ramifica por kind (DEVICE→ítem, MATERIAL→consumo create-if-missing) — cierra el agujero de materiales huérfanos | ✅ prod |
| F4 | El sidebar "Inventario del cliente" (CustomerSidebar) muestra el inventario real del contrato (read-only) — reemplaza el placeholder "Próximamente" | ✅ prod |
| F5 | Permiso `inventory.write` (RBAC, otorgado a tecnico+administrador+super_admin) + migración de las rutas del inventario del contrato `clients.*→inventory.*` | ✅ prod |

## Batches (modo automático, Strict TDD)

| Batch | Fases | Commit | Tests |
|-------|-------|--------|-------|
| A | 1-4: schema+migraciones, domain, adapters, MaterialCatalog CRUD+service+DTO | BE `8db351f4` | 40 |
| B | 5-7: consumo + RemoveInstalledItem + confirm kind-branch + rutas + DI + perms | BE `9a9e0180` | suite 2197 |
| D | 8-11: FE (tab Materiales, edit/quitar equipos, consumo, F4 sidebar) | FE `72bcc13` | vitest 1815 |

> Corrección de orquestador durante el apply: el agente implementó `RemoveInstalledItem` con error 409 al re-quitar; se corrigió a **idempotente** (no-op, retorna el item) + ruta DELETE 200, según la regla de reconciliación canónica.

## PRs / Deploys
- Backend: PR #31 → merged → deploy verde, 3 migraciones aplicadas (incluida la de permisos).
- Frontend: PR #26 → merged → deploy verde.

## Migraciones aplicadas en prod (todas aditivas)
- `20260604080000_add_material_catalog` — tabla + seed 7 materiales base idempotente (`ON CONFLICT (name) DO NOTHING`).
- `20260604090000_add_task_material_consumption` — tabla + 3 FK (taskId Cascade, materialCatalogId Restrict, recordedByUserId SetNull).
- `20260604100000_add_inventory_write_permission` — RBAC idempotente: crea `inventory.write` y otorga `inventory.read+write` a tecnico + administrador + super_admin.

## Decisiones de diseño clave
- **3 conceptos, no un `kind` en una tabla**: equipo = ESTADO (persiste), material = CONSUMO (evento por visita que sale de un stock). Separados para no complicar el control de stock futuro.
- **Remove idempotente** (soft `status='removed'`): re-quitar = no-op. DELETE → 200 + item.
- **ConfirmInventorySuggestion** unión discriminada `{kind:'DEVICE',item}|{kind:'MATERIAL',consumption}`; MATERIAL resuelve/crea el material por nombre canónico (create-if-missing, fallback `OTRO`).
- **`countInUse` por id** (FK), robusto a renombres.
- **`materialName` snapshot** preserva el texto original de IClass.
- **Permisos**: `inventory.read`/`write`/`manage` en ambas capas (FE Can/RequirePermission dot + BE requirePerm).

## Source of truth actualizada
- `openspec/specs/service-inventory-management/spec.md` (capability nueva, 42 requisitos RFC 2119).

## Engram (traceability)
- proposal/spec/design/tasks/apply-progress/archive-report bajo `sdd/service-inventory-management/*`.

## Fuera de scope (fase futura)
- **Control de stock**: `stockQuantity` en `MaterialCatalog`, decremento por consumo, restock. El modelo quedó listo (el consumo referencia el catálogo).
- Reportes de costo de material por cliente/contrato (la cadena `consumption → task.contractId → contract.clientId` está disponible).
- Reemplazo de equipo (`status='replaced'` con tracking del reemplazante).
