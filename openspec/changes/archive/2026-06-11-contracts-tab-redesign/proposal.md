# Proposal: contracts-tab-redesign (#42 — FE only)

## Intent

`view/:id#contracts` es una tabla plana con estilos inline: contratos no identificables (`type · plan`), sin dirección de instalación, sin servicios (#43 BE ya en prod, FE en cero), equipos visualmente desconectados. Re-diseño moderno (impeccable) + ABM "Servicios" en settings de clientes.

## Resolved Questions (blocking)

### 1. Contract.id es UUID string — el FE tipa mal, fix type-only

- BE: `Contract.id String @id @default(uuid())` (schema.prisma:208). `toService` mapea `id: row.id` (PrismaCustomerRepository.ts:57-83) → `GET /api/clients/:id/contracts` devuelve el **UUID**. No expone id numérico (`grContratoId` no está en el DTO).
- Los endpoints #43 (`PATCH /api/contracts/:id`, `POST/PATCH/DELETE /api/contracts/:contractId/services[/:id]`) toman ese MISMO UUID (contractServices.routes.ts).
- FE: `Contract.id: number` (types/customer.ts:4) es un type lie — en runtime llega string; `String(contract.id)` en ServiceInventorySection ya opera sobre string.
- **Estrategia**: cambiar FE a `id: string` (type-only, cero impacto runtime) y usar `contract.id` directo como `:contractId`. **Ningún cambio BE.**

### 2. CRUD viejo de contratos = stub in-memory → la UI nueva NO lo expone

- `POST/PATCH/DELETE /clients/:id/contracts[...]` operan sobre `contractsOverrideStore` (clients.routes.ts:58,348-386): POST escribe, PATCH/DELETE leen SOLO ese store, y `GET /:id/contracts` lee Prisma sin mergearlo. Nada persiste ni aparece en el GET; contra contratos reales (UUID) el `parseInt` → 404 siempre. No aceptan `name`.
- **Estrategia**: la UI nueva ELIMINA crear/editar(type-plan-ip)/borrar contrato. Acciones solo sobre endpoints reales: name (PATCH nuevo), services CRUD, catálogo ABM, equipos (ya real). Empty state informativo ("los contratos se sincronizan desde Gestión Real"), sin CTA falsa. `useAddContract/useUpdateContract/useDeleteContract` quedan sin consumers (solo ContractsTab + sus tests los usan) → remover.

## Scope

### In Scope
- Rewrite `ContractsTab` como contract cards + CSS Module nuevo.
- `ServiceInventorySection`: re-skin embebido en la card (remover `borderLeft` baneado, extraer a CSS Module).
- Types: `Contract.id: string`, `name`, `services: ContractService[]`, `ip` (BE manda `ip`, el FE hoy lee `ipAddress` → columna IP muestra "—"), `ServiceCatalogEntry`.
- API+hooks nuevos: `service-catalog.api` + `useServiceCatalog`, `contract-services.api` + `useContractServices`, `patchContractName` + `useUpdateContractName`.
- `ServiceCatalogBody` (clon DeviceTypesBody) + tab "Servicios" en `CustomersSettingsPage` (lazy, hash sync, `Can clients.manage`).

### Out of Scope
- Rediseño del resto de CustomerDetailPage; tab Equipos (W2); cambios BE; reemplazo del flujo create-contract (se elimina, no se migra).

## Capabilities

### New Capabilities
- `contracts-tab-ui`: UI FE de la tab de contratos (cards, name inline-edit, servicios, dirección, equipos) + ABM del catálogo en settings.

### Modified Capabilities
- None (BE specs `contract-naming`, `contract-service-catalog`, `contract-services` intactos).

## Approach

Approach A del explore (cards): header `name ?? plan` con **click-to-edit inline** (no modal) + pill de status HSL; dirección con label semántico "Instalación" (contrato=instalación vs cliente=facturación); chips de servicios con picker del catálogo activo (`GET /api/service-catalog?active=true`, `clients.read`), quitar con confirm (DELETE 204 idempotente), toggle active/inactive (PATCH status); sección equipos visualmente ligada a la card. Permisos: acciones `Can clients.write`; ABM `clients.manage`. Impeccable: HSL del page actual, pills `3px 8px / r100 / 12px`, sin side-stripes, sin modal single-field, empty states accionables solo si hay permiso.

## Affected Areas

| Area | Impact |
|---|---|
| `src/pages/customers/tabs/ContractsTab.tsx` + `.module.css` (nuevo) | Rewrite |
| `src/pages/customers/tabs/ServiceInventorySection.tsx` + `.module.css` (nuevo) | Re-skin |
| `src/types/customer.ts` | id:string, name, services, ip, ContractService, ServiceCatalogEntry |
| `src/api/customers.api.ts` | + `patchContractName`; − contract CRUD viejo |
| `src/api/service-catalog.api.ts`, `src/api/contract-services.api.ts` | New |
| `src/hooks/useCustomers.ts` | + `useUpdateContractName`; − hooks stub |
| `src/hooks/useServiceCatalog.ts`, `src/hooks/useContractServices.ts` | New |
| `src/pages/customers/settings/ServiceCatalogBody.tsx` + `.module.css` | New |
| `src/pages/customers/CustomersSettingsPage.tsx` | + tab Servicios |
| Tests: ContractsTab/CustomerDetailPage/ServicesTab + nuevos | Update/New |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `id: number→string` rompe call sites tipados number | Med | El compiler los lista; fix mecánico |
| Quitar UI de alta/baja de contratos es cambio visible | Low | El flujo nunca persistió (stub); empty state lo explica |
| Re-skin de ServiceInventorySection rompe equipos | Med | Tests existentes + extracción 1:1 a CSS Module antes de tocar layout |
| Tests viejos moquean hooks removidos | High | Actualizar mocks en el mismo PR |

## Rollback Plan

Revert del PR FE. Sin migraciones, sin BE, sin flags.

## Dependencies

- #43 BE en prod (confirmado en origin/main: routes + mapper + schema).

## Success Criteria

- [ ] Cards muestran `name ?? plan`, pill, dirección "Instalación", chips de servicios, equipos integrados.
- [ ] Name editable inline persiste vía `PATCH /api/contracts/:id`.
- [ ] Agregar/quitar/toggle servicios persiste y refresca la query de contratos.
- [ ] Tab "Servicios" en settings con ABM completo, gated `clients.manage`.
- [ ] Cero acciones de UI contra los endpoints stub; sin `borderLeft` side-stripe.
- [ ] Type-check y tests verdes con `Contract.id: string`.
