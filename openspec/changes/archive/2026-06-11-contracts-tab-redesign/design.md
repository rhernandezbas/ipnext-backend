# Design: contracts-tab-redesign (#42 — FE only)

## Technical Approach

Approach A del proposal: rewrite de `ContractsTab` como contract cards (container-presentational), data layer nuevo para los 3 endpoints de #43, ABM "Servicios" en settings clonando `DeviceTypesBody`, y eliminación del CRUD stub. Cero cambios BE. Registro impeccable: **product** (HSL/hex del page actual, Restrained, sin paleta nueva — NO OKLCH: `variables.css` y `CustomerDetailPage.module.css` son hex/HSL).

## Wire Contract (verbatim — todos los IDs son UUID string)

```
GET    /api/service-catalog[?active=true]                 clients.read   → 200 ServiceCatalogEntry[] (sortOrder asc)
POST   /api/service-catalog        { name, label?, sortOrder? }          clients.manage → 201 entry | 409 SERVICE_CATALOG_NAME_CONFLICT
PATCH  /api/service-catalog/:id    { name?, label?, active?, sortOrder? } clients.manage → 200 | 404 SERVICE_CATALOG_NOT_FOUND | 409 SERVICE_CATALOG_NAME_CONFLICT
DELETE /api/service-catalog/:id                                          clients.manage → 204 | 422 SERVICE_IN_USE | 422 SERVICE_CATALOG_NON_DELETABLE (OTROS) | 404
POST   /api/contracts/:contractId/services { serviceCatalogId, notes? }  clients.write  → 201 { id, contractId, serviceCatalogId, name, label, status:"active", notes, createdAt }
                                                                          | 409 CONTRACT_SERVICE_DUPLICATE | 422 SERVICE_CATALOG_INACTIVE | 404 CONTRACT_NOT_FOUND / SERVICE_CATALOG_NOT_FOUND
PATCH  /api/contracts/:contractId/services/:id { status?, notes? }       clients.write  → 200 | 404 CONTRACT_SERVICE_NOT_FOUND
DELETE /api/contracts/:contractId/services/:id                           clients.write  → 204 (idempotente)
PATCH  /api/contracts/:id          { name?: string | null }              clients.write  → 200 { id, name } | 404 CONTRACT_NOT_FOUND  ("" se normaliza a null)
GET    /api/clients/:id/contracts                                        clients.read   → 200 [{ id(UUID), type, plan, status, startDate, endDate, ip, address, lat, lng, technology, name, services: [] }]
```

Verificado en origin/main BE: `serviceCatalog.routes.ts` usa **PATCH** (DeviceTypes usa PUT — NO copiar el verbo). `contractServices.routes.ts:38` monta `PATCH /contracts/:id`.

## Architecture Decisions

| Decisión | Elección | Alternativa rechazada | Rationale |
|---|---|---|---|
| AD-1 Estructura componentes | `tabs/contracts/` subfolder: `ContractCard`, `InlineNameEdit`, `ContractServiceChips`, `ServicePickerMenu` + `ContractsTab.tsx` container en `tabs/` | Todo inline en ContractsTab | Precedente `SchedulingTaskDetailPage/components/`; container (queries/mutations) — presentational (cards) |
| AD-2 Name edit | Click-to-edit inline (pencil → input, Enter guarda, Esc cancela) | Modal single-field | Ban impeccable "modal as first thought"; un solo campo |
| AD-3 Services data | `services[]` llegan embebidos en `['client-contracts', clientId]`; `useContractServices` = SOLO mutations que invalidan esa key | Query separada por contrato | CSV-4 ya manda eager; evita N queries y doble fuente de verdad |
| AD-4 Picker servicios | Popover inline (patrón outside-click de `KebabMenu`, sin portal) listando catálogo activo no-asignado | Modal / select nativo | Acción liviana contextual; ban modal |
| AD-5 Toggle servicio | Click en el chip alterna active/inactive (PATCH status); "×" quita con `useConfirm` | Menú por chip | 2 acciones no ameritan menú; estado visual del chip ES el feedback |
| AD-6 ServiceInventorySection | Mismo archivo/path; Fase 1: extracción 1:1 inline-styles → `ServiceInventorySection.module.css` (borra `borderLeft` ban); Fase 2: layout dentro de la card | Componente nuevo | Test existente (`ServiceInventorySection.test.tsx`) protege la Fase 1; riesgo de regresión acotado |
| AD-7 CRUD stub | Remover hooks/api/UI de create/edit/delete contrato; `ServicesTab.tsx` (duplicado muerto, sin ruta) se ELIMINA con su test | Mantener deprecated | Único consumer de los aliases deprecated; nada persiste (stub) |
| AD-8 Status pill | Reutilizar átomo `StatusBadge` (ya implementa pill 3px 8px/r9999/12px y tokens `--badge-*`) con `label` override vía `clientStatusLabels` | Pill CSS propia | Componente y tokens ya existen; consistencia |
| AD-9 ABM settings | `ServiceCatalogBody` clon de `DeviceTypesBody`; tab `servicios` en `CustomersSettingsPage` gated `can('clients.manage')` | Página propia | Patrón establecido (Tecnologías gated `contracts.read` en el mismo Tabs lazy + hash) |

## Visual Design (impeccable — product register, tokens reales)

**Card** (`ContractCard.module.css`): `background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg);` stack vertical `gap: var(--space-4)` entre cards. Sin shadow, sin hover-lift (la card no es clickeable). **Prohibido**: side-stripes (`border-left>1px`), inline styles, grids de cards idénticas (stack full-width, densidad varía por contenido).

- **Header** (`padding: var(--space-4) var(--space-5) var(--space-3)`): título `name ?? plan` 15px/`--font-weight-semibold`/`--color-text-primary` + `StatusBadge` al lado; pencil de edición `opacity: 0` → `1` en `:hover` de la card y siempre con `:focus-visible`. Si `name` existe, `plan` baja a metadata.
- **Metadata** (13px `--color-text-secondary`, flex wrap `gap: var(--space-3)`): label `INSTALACIÓN` 11px/600/uppercase/`letter-spacing: .04em` (patrón `.fieldLabel` de `Tab.module.css`) + address; `ip` (campo nuevo — hoy el FE lee `ipAddress` y muestra "—"); `technology`; vigencia `startDate → endDate`.
- **Servicios** (`padding: var(--space-3) var(--space-5)`, `border-top: 1px solid var(--color-gray-100)`): label sección 11px uppercase; chips `gap: 6px`. Chip activo: `--badge-active-bg`/`--badge-active-fg`; inactivo: `--badge-inactive-bg`/`--badge-inactive-fg`; padding `3px 8px`, `border-radius: var(--radius-full)`, 12px/500, contenido `label ?? name`. Botón "+ Agregar servicio" estilo chip con borde dashed `--color-border`. Focus: `outline: 2px solid var(--color-primary); outline-offset: 2px`.
- **Equipos** (`border-top`, `padding: var(--space-3) var(--space-5) var(--space-4)`): `ServiceInventorySection` re-skineado; tabla densidad `DeviceTypesBody.module.css` (th 12px/600, td 13px), acciones link-style (`.linkBtn`/`.linkDanger`).
- **Empty states**: sin contratos → patrón `.placeholder` existente (dashed `--color-border`): "Este cliente no tiene contratos." / sub: "Los contratos se sincronizan desde Gestión Real." SIN CTA (no hay flujo de alta). Sin servicios → texto quieto + botón agregar solo con `clients.write`.
- **Responsive**: desktop-first (patrón del page: `flex-wrap` en `.subHeader`); metadata con wrap; tabla equipos `overflow-x: auto`.
- Espaciado variado (header 16/20/12, secciones 12/20) = ritmo, no monotonía.

## Data Flow

```
ContractsTab (container)
  ├─ useClientContracts(clientId)        key ['client-contracts', id]  (contracts + services[] embebidos)
  ├─ useServiceCatalog(true)             key ['service-catalog','active']   (picker, fetch lazy al abrir)
  └─ ContractCard ×N
       ├─ InlineNameEdit ── useUpdateContractName ──► PATCH /contracts/:id ──invalidate──► ['client-contracts', id]
       ├─ ContractServiceChips ── useAdd/Update/RemoveContractService(clientId) ──► /contracts/:cid/services ──invalidate──► ['client-contracts', id]
       └─ ServiceInventorySection (serviceId = contract.id, sin cambios de data)
Settings: ServiceCatalogBody ── useServiceCatalog() ['service-catalog'] + mutations ──invalidate prefix──► ['service-catalog'] (cubre 'active')
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/types/customer.ts` | Modify | `Contract.id: string`; `+ name?: string\|null`, `+ ip?: string\|null` (reemplaza `ipAddress`), `+ services: ContractService[]`; `+ ContractService`, `+ ServiceCatalogEntry`; − `AddContractData`/`UpdateContractData`/aliases |
| `src/api/service-catalog.api.ts` | Create | `serviceCatalogApi` (list/create/**patch**/delete) — clon `deviceTypes.api.ts` pero PATCH |
| `src/api/contract-services.api.ts` | Create | add/update/remove sobre `/contracts/:contractId/services` |
| `src/api/customers.api.ts` | Modify | `+ patchContractName(id: string, name: string\|null)`; − `addClientContract`/`updateClientContract`/`deleteClientContract` + aliases deprecated |
| `src/hooks/useServiceCatalog.ts` | Create | KEY `['service-catalog']`, variante `(activeOnly)` con key `['service-catalog','active']`; mutations invalidan prefix |
| `src/hooks/useContractServices.ts` | Create | `useAddContractService(clientId)` etc. — invalidan `['client-contracts', clientId]` |
| `src/hooks/useCustomers.ts` | Modify | `+ useUpdateContractName`; − `useAdd/Update/DeleteContract`, − aliases `useAdd/Update/DeleteService`, `useClientServices` |
| `src/pages/customers/tabs/ContractsTab.tsx` + `.module.css` | Rewrite/Create | Container + layout cards |
| `src/pages/customers/tabs/contracts/{ContractCard,InlineNameEdit,ContractServiceChips,ServicePickerMenu}.tsx` + `ContractCard.module.css` | Create | Presentational |
| `src/pages/customers/tabs/ServiceInventorySection.tsx` + `.module.css` | Modify/Create | Fase 1 extracción 1:1 (sin side-stripe), Fase 2 re-skin |
| `src/pages/customers/tabs/ServicesTab.tsx` | Delete | Duplicado muerto sin ruta; único consumer de aliases stub |
| `src/pages/customers/settings/ServiceCatalogBody.tsx` + `.module.css` | Create | Clon DeviceTypesBody. Diff: hooks/endpoint `/service-catalog`, PATCH, perm `clients.manage`, labels "servicio", delete guards **422** `SERVICE_IN_USE` ("hay contratos que usan este servicio") y `SERVICE_CATALOG_NON_DELETABLE` ("OTROS no se puede eliminar") — DeviceTypes usa 409, cambiar status+codes; create/update 409 `SERVICE_CATALOG_NAME_CONFLICT` |
| `src/pages/customers/CustomersSettingsPage.tsx` | Modify | `+ { id: 'servicios', label: 'Servicios' }` gated `can('clients.manage')` |
| `src/lib/buildContractLabel.ts` | Modify | `ContractLabelInput.id: string \| number` (template literal compatible) |

**Call sites que el compiler va a señalar con `id: string` / removals** (verificados con rg): `ContractsTab.tsx` (`editingId: number`, `handleDelete(number)` — rewrite), `ServicesTab.tsx` + `src/__tests__/customers/ServicesTab.test.tsx` (delete), `useCustomers.ts` / `customers.api.ts` (`contractId: number` — removed), `buildContractLabel.ts:2`, `src/__tests__/customers/CustomerDetailPage.test.tsx:99-112` (mocks de hooks removidos — quitar), fixtures con `id` numérico de contratos en `src/__tests__/scheduling/{CustomerSidebar,components/DatosForm,components/CreateTaskModal,components/CreateTaskModal.network}.test.tsx` (fix mecánico `id: 'c1'`; el código scheduling ya usa `String(s.id)` — runtime intacto).

## Testing Strategy

| Layer | Test | Approach |
|---|---|---|
| Wire (lección #28) | `serviceCatalog.api.test.ts`, `contractServices.api.test.ts`, `customers.api` patchContractName | `vi.mock('@/api/axios-client')`; assert URL/verbo/payload exactos (patrón `createTaskFromTicket.api.test.ts`) |
| Component | `ContractsTab.test.tsx` (nuevo) | DOM real: título `name ?? plan`, metadata `ip`/address, chips, empty state sin CTA; name edit Enter→`patchContractName(uuid, name)`; add/toggle/remove servicio + invalidación; permisos con `vi.mock('@/hooks/useMyPermissions')` + `mockPerms(can)` (lección #41, patrón `RetirementProjectsBody.test.tsx:16-60`) |
| Component | `ServiceCatalogBody.test.tsx` | list/create/409 conflict msg/delete guards 422×2/gating `clients.manage` |
| Component | `CustomersSettingsPage.test` | tab Servicios visible solo con `clients.manage`; hash `#servicios` |
| Regression | `ServiceInventorySection.test.tsx` | DEBE quedar verde tras Fase 1 (extracción sin cambios de DOM/copy) |
| Cleanup | `CustomerDetailPage.test.tsx` | quitar mocks de hooks removidos |

## Migration / Rollout

No migration. Revert del PR FE. Orden de implementación: types+api+hooks (wire tests) → ServiceInventorySection Fase 1 → ContractsTab rewrite → ServiceCatalogBody+settings → removals/cleanup.

## Open Questions

None.
