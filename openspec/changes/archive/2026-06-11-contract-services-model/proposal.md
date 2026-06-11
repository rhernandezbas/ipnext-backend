# Proposal: contract-services-model (#43)

## Intent

Cliente → N Contratos identificables (con `name`) → servicios contratados (catálogo editable) + equipos (sin cambios). Semántica de direcciones: **cliente = facturación, contrato = instalación (GR la trae)**. Este cambio entrega MODELO + API; la UI es #42 y TV (#47) linkeará a `ContractService`.

## Scope

### In
- `Contract.name String?` — manual-only, excluido del upsert del sync (patrón `technology`, guard en `PrismaClientMirrorRepository.upsertContract`). Display: `name ?? plan`.
- `ServiceCatalog` (clon `DeviceTypeCatalog`: `name` UNIQUE uppercase, `label?`, `active`, `sortOrder`) + seed idempotente `ON CONFLICT (name) DO NOTHING`: INTERNET, TV, VOZ, CAMARAS, OTROS (OTROS no-borrable, patrón `DeleteDeviceType.ts:11`).
- `ContractService` pivot: `id, contractId FK cascade, serviceCatalogId FK restrict, status active|inactive default active, notes?, createdAt, UNIQUE(contractId, serviceCatalogId)`. Listo para metadata externa futura (#47) sin agregarla hoy.
- API aditiva + CRUD (sketch abajo). 2 migraciones: `20260625000000_contract_name`, `20260626000000_service_catalog` (main está en 20260623; 20260624 reservado por UISP).

### Out
- UI (#42) · ítem TV (#47) · edición manual de address (GR-wins se MANTIENE — `upsertContract` siempre escribe `address/lat/lng`) · servicios en el sync GR (nunca toca `name` ni `ContractService`).

## Capabilities

### New
- `contract-service-catalog`: ABM del catálogo de servicios (espejo device-types).
- `contract-services`: servicios por contrato (pivot CRUD + eager en respuesta de contratos).
- `contract-naming`: campo `name` manual + endpoint de edición.

### Modified
- None (cambios de respuesta son aditivos, capturados en las nuevas capabilities).

## Wire Contract

`GET /api/clients/:id/contracts` — ADITIVO, shape actual intacto:
```
{ id, type, plan, status, startDate, endDate?, ip?,
  address?, lat?, lng?,        // ya existe; instalación, GR-wins
  technology?,
  name: string|null,           // NUEVO, manual
  services: [{ id, serviceCatalogId, name, label, status, notes, createdAt }] }  // NUEVO, eager include — sin N+1
```
- `POST /api/contracts/:contractId/services {serviceCatalogId, notes?}` → 201 · 409 duplicado
- `PATCH /api/contracts/:contractId/services/:id {status?, notes?}` → 200
- `DELETE /api/contracts/:contractId/services/:id` → 204 idempotente
- `GET/POST /api/service-catalog` · `PATCH/DELETE /api/service-catalog/:id` (OTROS protegido, in-use → 409)
- `PATCH /api/contracts/:id {name}` → **NUEVO**: no existe update persistente de contrato (el `PATCH /api/clients/:id/contracts/:contractId` de `clients.routes.ts:353` escribe a `contractsOverrideStore` in-memory — stub, no reusable).

## Permisos (evidencia verificada)

- Catálogo RBAC seedea read/write/delete/manage para módulo `clients` (`20260529000000_auth_rbac_foundation`, CROSS JOIN 4 acciones) → **`clients.manage` EXISTE**.
- FE `can()` chequea membership de strings del `/me` (`useMyPermissions.ts`) — sin catálogo hardcodeado FE → no requiere cambio coordinado.
- FE hoy: rutas con `clients.read` (App.tsx:175-182), ContractsTab con `clients.write` (ContractsTab.tsx:107).
- **Decisión**: lecturas `clients.read` · servicios x contrato y `PATCH name` `clients.write` · ABM catálogo `clients.manage`. BE: `requirePerm('clients', …)` en todas las rutas nuevas (dos capas).

## Affected Areas

| Area | Impact |
|---|---|
| `prisma/schema.prisma` + 2 migraciones | Modified/New |
| `src/domain/{entities,ports}` — serviceCatalog, contractService; `customer.ts` +name | New/Modified |
| `src/application/{use-cases,dto,services}` — ABM catálogo, CRUD pivot, UpdateContractName | New |
| `src/infrastructure/adapters/{prisma,in-memory}` + `routes` + `app.ts` wiring | New/Modified |
| `PrismaClientMirrorRepository` | Sin cambios de código; extender comentario GUARD a `name` |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Romper contrato API FE en prod | Low | Solo campos aditivos; tests supertest del shape actual |
| N+1 en services | Med | `include` eager en `listContracts` |
| Sync pisa `name` | Low | Excluido del data object + test de regresión |
| Colisión timestamp migración con branch UISP | Low | Usar 20260625+/20260626+ |

## Rollback

Revert del deploy + `DROP TABLE "ContractService", "ServiceCatalog"; ALTER TABLE "Contract" DROP COLUMN "name";` (aditivo puro, sin pérdida de datos existentes).

## Post-deploy

Ninguno esperado — el catálogo se seedea en la migración.

## Success Criteria

- [ ] `GET /api/clients/:id/contracts` devuelve `name` + `services[]` sin romper shape actual (test supertest).
- [ ] Sync GR nunca modifica `name` ni `ContractService` (test de regresión).
- [ ] ABM catálogo gateado `clients.manage`; OTROS no-borrable; seed idempotente re-ejecutable.
- [ ] Duplicado de servicio en contrato → 409; DELETE idempotente → 204.
