# Proposal: Inventory Depot Stock (EPIC #38, Wave 3)

## Intent

Técnicos y admins necesitan ver qué equipos y materiales están disponibles en el depósito (DEPOSITO) antes de planificar tareas. Hoy no existe ningún endpoint ni vista para esto. La funcionalidad es **read-only** — la gestión de movimientos llega en Wave 4.

## Scope

### In Scope
- BE: `listByLocation(locationId)` en ports `InventoryAssetRepository` + `MaterialStockRepository`, adaptadores Prisma + InMemory.
- BE: use case `GetDepotStock` — busca `DEPOSITO` vía `findByCode`, devuelve vacío si no existe, de lo contrario lista assets (status=available) + materials + enriquecimiento por catálogos.
- BE: endpoint `GET /api/inventory/depot` con permiso `inventory.read`, cableado en `app.ts`.
- FE: `src/types/depot.ts` (DTOs), `src/api/depot.api.ts`, hook `useDepotStock`.
- FE: página `InventoryDepotPage` en `/admin/inventory/depot` con dos secciones (Equipos disponibles / Materiales) + empty states contextuales por sección.
- FE: ruta en `App.tsx`, gateada `inventory.read`.

### Out of Scope
- Cualquier mutación (altas, bajas, movimientos) — Wave 4.
- Limpieza de las páginas World-A muerta (`/inventory/dashboard`, `/inventory/items`, etc.) — pase futuro independiente.
- Seeding de materiales — Wave 6.
- ResolveDepotLocation (no se usa en un GET).

## Capabilities

### New Capabilities
- `depot-stock`: Vista read-only del stock en la ubicación DEPOSITO (assets disponibles + materiales con catálogo enriquecido).

### Modified Capabilities
- `service-inventory`: agregar `listByLocation` a los ports existentes `InventoryAssetRepository` y `MaterialStockRepository` (comportamiento nuevo, specs existentes intactas).

## Approach

Puramente aditivo. Sigue el patrón Wave 2 (`ListClientEquipment` → `GET /api/clients/:clientId/equipment` → `useClientEquipment`):

1. Agregar método al port (interfaz) → implementar en Prisma adapter → implementar en InMemory adapter.
2. Nuevo use case con 5 dependencias inyectadas; parallel `listByLocation` para assets y materials, enriquecimiento en memoria.
3. Nueva route file `inventory.routes.ts` montada en `app.ts` bajo `/api/inventory`.
4. FE: API fn → hook → page; NO tocar `inventory.api.ts` (stub roto).

`app.ts` sí se toca (God Object), pero la adición es mínima (montar un router).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/domain/ports/InventoryAssetRepository.ts` | Modified | + `listByLocation(locationId: string): Promise<InventoryAsset[]>` |
| `src/domain/ports/MaterialStockRepository.ts` | Modified | + `listByLocation(locationId: string): Promise<MaterialStock[]>` |
| `src/infrastructure/adapters/prisma/PrismaInventoryAssetRepository.ts` | Modified | Implementar `listByLocation` con filtro `status=available` |
| `src/infrastructure/adapters/prisma/PrismaMaterialStockRepository.ts` | Modified | Implementar `listByLocation` |
| `src/infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository.ts` | Modified | Implementar `listByLocation` |
| `src/infrastructure/adapters/in-memory/InMemoryMaterialStockRepository.ts` | Modified | Implementar `listByLocation` |
| `src/application/use-cases/GetDepotStock.ts` | New | Use case principal, 5 deps |
| `src/infrastructure/http/routes/inventory.routes.ts` | New | `GET /depot` → `GetDepotStock` |
| `src/infrastructure/http/app.ts` | Modified | Montar `inventoryRouter` en `/api/inventory` |
| `src/__tests__/application/GetDepotStock.test.ts` | New | TDD unit tests |
| `src/__tests__/infrastructure/inventory.routes.test.ts` | New | Supertest integration tests |
| FE `src/types/depot.ts` | New | DepotAssetDTO, DepotMaterialDTO, DepotStockDTO |
| FE `src/api/depot.api.ts` | New | `getDepotStock(): Promise<DepotStockDTO>` |
| FE `src/hooks/useDepotStock.ts` | New | React Query hook |
| FE `src/pages/inventory/InventoryDepotPage.tsx` | New | Dos secciones + empty states contextuales |
| FE `src/App.tsx` | Modified | Ruta `/admin/inventory/depot` gateada `inventory.read` |

## DTO Shapes

```typescript
// Backend response / FE types (src/types/depot.ts)
interface DepotAssetDTO {
  id: string;
  serialNumber: string;
  mac: string | null;
  deviceTypeId: string;
  deviceTypeName: string;
  deviceTypeLabel: string | null;
  status: 'available';
  sourceTaskId: string | null;
}
interface DepotMaterialDTO {
  id: string;
  materialCatalogId: string;
  name: string;
  label: string | null;
  unit: string | null;
  qty: number;
}
interface DepotStockDTO {
  assets: DepotAssetDTO[];
  materials: DepotMaterialDTO[];
  depotLocationId: string | null;
}
```

## Settled Decisions (design phase skippable)

1. **Nueva página** — no reutilizar World-A scaffolding.
2. **`findByCode('DEPOSITO')` sin writes** — `ResolveDepotLocation` fuera de scope en un GET.
3. **Endpoint**: `GET /api/inventory/depot` → `{assets, materials, depotLocationId}`, perm `inventory.read`.
4. **Empty state copy**: por sección — Equipos menciona devoluciones W4, Materiales menciona carga de stock.
5. **`depot.api.ts` separado** — `inventory.api.ts` es un stub roto; aislamiento explícito.

## Design (lightweight)

### Sequence: GET /api/inventory/depot

```
Client → GET /api/inventory/depot
  → requirePermission('inventory.read')
  → GetDepotStock.execute()
      → StockLocationRepo.findByCode('DEPOSITO')
      ├─ null → return { assets: [], materials: [], depotLocationId: null }
      └─ found(depot)
          → [parallel]
              InventoryAssetRepo.listByLocation(depot.id)   // filter status=available in query
              MaterialStockRepo.listByLocation(depot.id)
          → [parallel enrichment]
              DeviceTypeCatalogRepo.findById per unique deviceTypeId
              MaterialCatalogRepo.findById per unique materialCatalogId
          → map to DepotAssetDTO[] + DepotMaterialDTO[]
          → return { assets, materials, depotLocationId: depot.id }
  → 200 JSON
```

### Architecture Notes
- Use case depends ONLY on the 5 port interfaces (DIP compliant).
- `listByLocation` on `InventoryAssetRepository` MUST filter `status='available'` at DB level (not in use case) to keep the port generic enough for future reuse.
- No new DB tables or migrations required — `stockLocationId` FK already exists on both `InventoryAsset` and `MaterialStock`.
- FE: `useDepotStock` wraps `getDepotStock()` with React Query; `staleTime: 30s` acceptable (read-only, low-churn data).

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Depósito vacío en producción (0 assets, 0 materials) | High | Empty states contextuales por sección; `depotLocationId: null` fluye al FE sin error |
| `app.ts` God Object cresce | Low | La modificación es solo `app.use('/api/inventory', inventoryRouter)` — 1 línea |
| `inventory.api.ts` stub contamina FE | Low | `depot.api.ts` completamente independiente |
| 5-dep constructor en GetDepotStock | Low | Patrón ya usado en otros use cases del proyecto |

## Rollback Plan

Todos los cambios son aditivos. Rollback = revert commits o drop del router en `app.ts`. No hay migraciones de DB. El FE rollback es eliminar la ruta en `App.tsx`.

## Dependencies

- Wave 1 ports y adapters ya existen (confirmado por exploración).
- Permiso `inventory.read` ya está en el catálogo RBAC (verificar antes de implementar).

## Success Criteria

- [ ] `GET /api/inventory/depot` retorna `{assets, materials, depotLocationId}` con perm `inventory.read`.
- [ ] Si `DEPOSITO` no existe → `{assets:[], materials:[], depotLocationId:null}` (no 404, no 500).
- [ ] Assets filtran solo `status=available`.
- [ ] DTOs enriquecidos con nombre/label/unit del catálogo — nunca entidades Prisma raw.
- [ ] Tests: `GetDepotStock.test.ts` (unit, in-memory) + `inventory.routes.test.ts` (supertest).
- [ ] `InventoryDepotPage` muestra dos secciones con empty states contextuales.
- [ ] Ruta gateada — usuario sin `inventory.read` recibe 403.
- [ ] Ninguna página World-A modificada.
