# contracts-tab-ui Specification

**Capability**: `contracts-tab-ui` (NEW — FE only)
**Change**: `contracts-tab-redesign` (#42)
**Summary**: Rewrite `ContractsTab` as contract cards; inline name edit; service chips with add/remove/toggle; `ServiceInventorySection` re-skin; `ServiceCatalogBody` ABM in settings. No create/edit-plan/delete contract UI.

---

## Wire Contract

| Endpoint | Method | Permission | Request | Response shape |
|----------|--------|------------|---------|----------------|
| `/api/clients/:id/contracts` | GET | `clients.read` | — | `Contract[]` (see below) |
| `/api/contracts/:id` | PATCH | `clients.write` | `{ name?: string \| null }` | `{ id, name }` |
| `/api/contracts/:contractId/services` | POST | `clients.write` | `{ serviceCatalogId, notes? }` | `{ id, contractId, serviceCatalogId, name, label, status, notes, createdAt }` |
| `/api/contracts/:contractId/services/:id` | PATCH | `clients.write` | `{ status?, notes? }` | same shape |
| `/api/contracts/:contractId/services/:id` | DELETE | `clients.write` | — | 204 |
| `/api/service-catalog` | GET | `clients.read` | `?active=true` | `ServiceCatalogEntry[]` |
| `/api/service-catalog` | POST | `clients.manage` | `{ name, label, sortOrder }` | `ServiceCatalogEntry` |
| `/api/service-catalog/:id` | PATCH | `clients.manage` | partial fields | `ServiceCatalogEntry` |
| `/api/service-catalog/:id` | DELETE | `clients.manage` | — | 204 \| 422 |

**`Contract` shape** (from `GET /api/clients/:id/contracts`):
`{ id: string (UUID), name: string|null, type, plan, status, ip, address, lat, lng, technology, startDate, endDate, services: ContractService[] }`

**`ContractService` shape**: `{ id, serviceCatalogId, name, label, status: "active"|"inactive", notes, createdAt }`

**`ServiceCatalogEntry` shape**: `{ id, name, label, active, sortOrder, createdAt, updatedAt }`

---

## Requirements

### Requirement CTU-1: Contract.id typed as string (UUID)

The FE type `Contract.id` MUST be `string`. All call sites using `contract.id` as path parameter MUST pass it directly without `parseInt` or `String()` coercion.

#### Scenario CTU-1.1: No runtime coercion needed

- GIVEN `GET /api/clients/:id/contracts` returns `id` as UUID string
- WHEN `ContractsTab` renders and service endpoints are called
- THEN `contract.id` MUST be used verbatim as `:contractId` — no coercion

#### Scenario CTU-1.2: TypeScript build passes

- GIVEN `Contract.id: string` is set in `src/types/customer.ts`
- WHEN `tsc --noEmit` runs
- THEN zero type errors related to `Contract.id` MUST occur

---

### Requirement CTU-2: Contract ip field aligned (drift fix)

The FE MUST read `contract.ip` (not `contract.ipAddress`). The IP column MUST render the real value instead of `"—"`.

#### Scenario CTU-2.1: IP renders correctly

- GIVEN a contract with `ip = "10.0.1.5"` returned by the BE
- WHEN `ContractsTab` renders
- THEN the IP value `"10.0.1.5"` MUST be visible — not `"—"`

---

### Requirement CTU-3: Contract cards layout

The system MUST render each contract as a CSS-Module card (no inline styles). Each card MUST show: header `name ?? plan` + status pill (HSL, `3px 8px / r100 / 12px/500`); address labelled "Instalación"; service chips section; equipment section. No `borderLeft` side-stripe anywhere.

#### Scenario CTU-3.1: Header shows name when set

- GIVEN `contract.name = "Fibra Casa"`
- WHEN the card renders
- THEN the header MUST display `"Fibra Casa"` (not the plan)

#### Scenario CTU-3.2: Header falls back to plan when name is null

- GIVEN `contract.name = null` and `contract.plan = "FIBRA 100MB"`
- WHEN the card renders
- THEN the header MUST display `"FIBRA 100MB"`

#### Scenario CTU-3.3: Address labelled as "Instalación"

- GIVEN `contract.address = "Av. Corrientes 500"`
- WHEN the card renders
- THEN a label `"Instalación"` MUST precede or annotate the address text

---

### Requirement CTU-4: Inline name edit

The system MUST allow click-to-edit of the contract name when the user has `clients.write`. Enter saves via `PATCH /api/contracts/:id { name }`; Esc cancels. Empty input MUST send `name: null`. Read-only without `clients.write`.

#### Scenario CTU-4.1: Save on Enter

- GIVEN user clicks the name, types `"Nueva Fibra"`, presses Enter
- WHEN `useUpdateContractName` resolves
- THEN the card header MUST update to `"Nueva Fibra"` and the input MUST close

#### Scenario CTU-4.2: Cancel on Esc

- GIVEN user is editing the name
- WHEN Esc is pressed
- THEN the original name MUST be restored and no PATCH call MUST be made

#### Scenario CTU-4.3: Empty input clears name

- GIVEN user clears the input and presses Enter
- WHEN the PATCH resolves
- THEN the card header MUST show `contract.plan` (name is null)

#### Scenario CTU-4.4: Read-only without clients.write

- GIVEN user lacks `clients.write`
- WHEN the contract card renders
- THEN the name MUST NOT be clickable/editable

---

### Requirement CTU-5: Service chips — add, remove, toggle

The system MUST show each `ContractService` as a chip with `active`/`inactive` visual state. Adding a service MUST open a picker filtered to `GET /api/service-catalog?active=true` excluding already-added entries. Removing requires a confirm dialog. Toggle calls `PATCH status`. 409 from add MUST show a toast error. All actions require `clients.write`.

#### Scenario CTU-5.1: Add service — happy path

- GIVEN catalog has INTERNET (active) and INTERNET is not in `contract.services`
- WHEN user selects INTERNET from the picker and confirms
- THEN `POST /api/contracts/:id/services` MUST be called and the chip MUST appear

#### Scenario CTU-5.2: Add service — 409 handled

- GIVEN the POST returns 409 `CONTRACT_SERVICE_DUPLICATE`
- WHEN the response arrives
- THEN a toast error MUST be shown; the chip list MUST NOT duplicate

#### Scenario CTU-5.3: Remove service with confirm

- GIVEN user clicks remove on a service chip
- WHEN they confirm in the dialog
- THEN `DELETE /api/contracts/:id/services/:serviceId` MUST be called; chip MUST disappear

#### Scenario CTU-5.4: Toggle service status

- GIVEN a chip with `status = "active"`
- WHEN user clicks the toggle
- THEN `PATCH /api/contracts/:id/services/:serviceId { status: "inactive" }` MUST be called; chip visual MUST update

#### Scenario CTU-5.5: Picker excludes already-added services

- GIVEN contract has INTERNET in `services`
- WHEN the add picker opens
- THEN INTERNET MUST NOT appear as an option

#### Scenario CTU-5.6: Read-only chips without clients.write

- GIVEN user lacks `clients.write`
- WHEN the card renders
- THEN add/remove/toggle controls MUST NOT be visible

---

### Requirement CTU-6: Removed contract-level CRUD actions

The UI MUST NOT expose create-contract, edit-type/plan, or delete-contract actions. `useAddContract`, `useUpdateContract`, `useDeleteContract` MUST be removed; no other consumer exists.

#### Scenario CTU-6.1: No create button in ContractsTab

- GIVEN any authenticated user on the Contracts tab
- WHEN the tab renders
- THEN no "Agregar contrato" button or form MUST appear

#### Scenario CTU-6.2: Removed hooks have no consumers after removal

- GIVEN `useAddContract`/`useUpdateContract`/`useDeleteContract` are deleted
- WHEN `tsc --noEmit` runs
- THEN zero "cannot find name" errors for those identifiers MUST occur (no consumers left)

---

### Requirement CTU-7: Empty states

The system MUST show an empty state when a client has no contracts (informational, no CTA). A contract with no services MUST show a hint "Agregá un servicio" only when the user has `clients.write`. The service catalog with no custom entries MUST show an informational state.

#### Scenario CTU-7.1: No contracts — informational state

- GIVEN `GET /api/clients/:id/contracts` returns `[]`
- WHEN `ContractsTab` renders
- THEN an informational message (e.g., "Los contratos se sincronizan desde Gestión Real") MUST appear with no add-contract CTA

#### Scenario CTU-7.2: No services on contract — actionable hint for writers

- GIVEN `contract.services = []` and user has `clients.write`
- WHEN the card renders
- THEN a hint "Agregá un servicio" (or equivalent actionable copy) MUST appear within the card

#### Scenario CTU-7.3: No services on contract — informational for readers

- GIVEN `contract.services = []` and user lacks `clients.write`
- WHEN the card renders
- THEN an informational empty state MUST appear without any CTA

---

### Requirement CTU-8: ServiceInventorySection CSS Module extraction

`ServiceInventorySection` MUST be extracted to a CSS Module. The `borderLeft` inline style MUST be removed. Equipment MUST remain functionally identical.

#### Scenario CTU-8.1: No borderLeft in rendered output

- GIVEN `ServiceInventorySection` renders equipment for a contract
- WHEN the component is mounted
- THEN no element MUST have a `borderLeft` inline style or equivalent side-stripe class

#### Scenario CTU-8.2: Equipment display unchanged after extraction

- GIVEN a contract with installed equipment
- WHEN `ServiceInventorySection` renders
- THEN all equipment items visible before extraction MUST still render correctly

---

### Requirement CTU-9: ServiceCatalogBody — settings tab ABM

`CustomersSettingsPage` MUST include a "Servicios" tab (lazy, hash sync) rendering `ServiceCatalogBody` gated by `clients.manage`. `ServiceCatalogBody` MUST clone `DeviceTypesBody` patterns: list with name/label/active/sortOrder; create modal; edit inline/modal; delete with confirm. 409 (name conflict) and 422 (in use / non-deletable) MUST be handled with toast errors. OTROS MUST NOT be deletable (BE returns 422 `SERVICE_CATALOG_NON_DELETABLE`).

#### Scenario CTU-9.1: Tab visible with clients.manage

- GIVEN user has `clients.manage`
- WHEN `CustomersSettingsPage` renders
- THEN a "Servicios" tab MUST be present and load `ServiceCatalogBody`

#### Scenario CTU-9.2: Tab hidden or read-only without clients.manage

- GIVEN user lacks `clients.manage`
- WHEN `CustomersSettingsPage` renders
- THEN the "Servicios" tab MUST be absent or all mutation controls MUST be disabled

#### Scenario CTU-9.3: Create entry — 409 handled

- GIVEN user submits a name that already exists
- WHEN the POST returns 409 `SERVICE_CATALOG_NAME_CONFLICT`
- THEN a toast MUST appear; the modal MUST stay open for correction

#### Scenario CTU-9.4: Delete OTROS — 422 handled

- GIVEN user attempts to delete the OTROS entry
- WHEN the DELETE returns 422 `SERVICE_CATALOG_NON_DELETABLE`
- THEN a toast MUST appear; the entry MUST remain in the list

#### Scenario CTU-9.5: Tab lazy-loaded and hash-synced

- GIVEN user navigates directly to `#servicios` in `CustomersSettingsPage`
- WHEN the page mounts
- THEN the "Servicios" tab MUST be active without requiring a manual click

---

## Constraints

- ALL CSS MUST use CSS Modules — zero inline styles; zero Tailwind
- Status pill: `background HSL`; padding `3px 8px`; `border-radius: 100px`; `font-size: 12px; font-weight: 500`
- Cards: `background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md)`
- Typography: name/plan header 14-15px/600; address 13px/400/secondary; section labels 11-12px/600/uppercase; chips 12px/500
- `borderLeft` side-stripe is absolutely banned in all components touched by this change
- `Can clients.write` gates all mutation controls in `ContractsTab`; `Can clients.manage` gates `ServiceCatalogBody`
- Errors from BE MUST be surfaced via `mapError` toast pattern (consistent with the rest of the page)
- Loading states MUST use the skeleton/spinner pattern consistent with `CustomerDetailPage`
- `buildContractLabel` helper in `src/lib/buildContractLabel.ts` MUST be used or explicitly deprecated (not duplicated)
