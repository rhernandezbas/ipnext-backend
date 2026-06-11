# Exploration: contracts-tab-redesign (#42)

## Current State

### ContractsTab (FE)
`src/pages/customers/tabs/ContractsTab.tsx` — plain HTML table with inline styles, no CSS Module. Renders contracts with columns: Tipo / Plan / IP / Estado / Fecha inicio / Fecha fin / Acciones. Uses `SERVICE_TYPES = ['internet', 'voz', 'tv']` hardcoded. Form is an inline show/hide block (not a modal).

Contract identifier shown as `{contract.type} · {contract.plan}` — no support for `name` or `address` yet. Services (ContractService) not wired at all — `#43` just shipped the BE but FE has ZERO api/hook for service-catalog or contract-services. `buildContractLabel` in `src/lib/buildContractLabel.ts` exists but only used in scheduling, not in ContractsTab.

### Inventory section per contract
`ServiceInventorySection` (`src/pages/customers/tabs/ServiceInventorySection.tsx`) is already functional: shows installed equipment per contract, wired via `serviceId = String(contract.id)`, `enabled = active`. Uses proper design patterns (modal, useConfirm). It is rendered below the contracts table as a simple stacked list — no visual grouping per contract card.

### CustomerDetailPage
`src/pages/customers/CustomerDetailPage.tsx` — tab `contracts` deep-linked via `#contracts` hash. `ContractsTab` receives `clientId` and `active` (lazy mount flag). `Can permission="clients.write"` already used. `canViewEquipment = useCan('inventory.read')` gates the Equipos tab. No `clients.manage` check exists yet in this page.

### Hooks / API layer
- `useClientContracts(id, enabled)` — calls `GET /api/clients/:id/contracts`. Returns `Contract[]` from `src/types/customer.ts`. The `Contract` type already has `address?`, `lat?`, `lng?`, `technology?` but is MISSING `name?: string | null` and `services?: ContractService[]`. Both are now available from the BE (shipped in #43).
- `useAddContract`, `useUpdateContract`, `useDeleteContract` — all exist in `useCustomers.ts`. `UpdateContractData` doesn't include `name`. `addClientContract` posts to `/clients/:id/contracts`.
- NO `useServiceCatalog` hook exists. NO `useContractServices` hook exists. NO `patchContractName` API call exists.
- The `updateClientContract` call is `PATCH /clients/:clientId/contracts/:contractId` — this is the OLD contract-level patch. The new name endpoint is `PATCH /api/contracts/:id { name }` — different URL structure, needs a new api function.

### Settings — existing patterns
- `CustomersSettingsPage` (`src/pages/customers/CustomersSettingsPage.tsx`) already EXISTS with tabs: GR Sync + Tecnologías. It uses `clients.read` to gate Tecnologías tab and follows the standard lazy-tab pattern.
- `InventorySettingsPage` (`src/pages/inventory/InventorySettingsPage.tsx`) has Equipos/Materiales/Camionetas/Automatizaciones/Proyectos-retiro tabs — each a `*Body` component (toolbar + card + table + modal).
- The `DeviceTypesBody` pattern in `src/pages/inventory/settings/DeviceTypesBody.tsx` is EXACTLY the pattern to clone for `ServiceCatalogBody`. It uses: `useDeviceTypes`, `useCreateDeviceType`, `useUpdateDeviceType`, `useDeleteDeviceType`; modal with name/label/active/sortOrder fields; `useConfirm` for delete; 409/422 error codes; `clients.manage` → `inventory.manage` permission swap.
- `ServiceTechnologiesBody` (`src/pages/contracts/ServiceTechnologiesBody.tsx`) is another direct reference — same pattern, already lives in the customers domain.

### Design System
- Tokens: `--space-*`, `--radius-*`, `--shadow-*`, `--color-*`, `--font-size-*`, `--font-weight-*` in `src/tokens/variables.css`.
- Status pills: standard HSL system (`statusActive: bg #dbeafe; color #1e40af`). Pill padding: `3px 8px; border-radius: 100px; font-size: 12px / 500`.
- Cards: `background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 20-24px`.
- Tables: border + radius wrapper; `th` 12px/600/uppercase; `td` 12-13.5px; `tr:hover` background transition.
- Modals: fixed overlay + blur; box 480-580px; sticky header; shadow-lg.
- No inline styles. No Tailwind. CSS Module per component/page.
- OKLCH only when the whole page uses OKLCH (CustomerDetailPage uses HSL/hex).
- Bans: no side-stripe borders (the current `ServiceInventorySection` has `borderLeft: '3px solid #e5e7eb'` — this is one of the absolute bans and must be removed in the redesign). No gradient text. No identical card grids.

### Permissions used today
- `clients.write` — create/edit/delete contracts; add/remove services
- `clients.delete` — delete contract
- `inventory.read` — gates Equipos tab in CustomerDetailPage
- `inventory.write` — add/edit/remove installed items in ServiceInventorySection
- NEW needed: `clients.manage` — gates service-catalog ABM in settings

---

## Affected Areas

- `src/pages/customers/tabs/ContractsTab.tsx` — full rewrite; the primary deliverable
- `src/pages/customers/tabs/ContractsTab.module.css` — new CSS Module (doesn't exist yet)
- `src/pages/customers/tabs/ServiceInventorySection.tsx` — refactor visual (remove side-stripe ban); may be promoted to be embedded inside each contract card
- `src/types/customer.ts` — add `name?: string | null` and `services?: ContractService[]` to `Contract`; add `ContractService` and `UpdateContractData.name` types; add `ServiceCatalogEntry` type
- `src/api/customers.api.ts` — add `patchContractName(contractId, name)` calling `PATCH /api/contracts/:id`
- `src/api/service-catalog.api.ts` — NEW file for `/api/service-catalog` CRUD
- `src/api/contract-services.api.ts` — NEW file for `/api/contracts/:contractId/services` CRUD
- `src/hooks/useCustomers.ts` — add `useUpdateContractName` mutation
- `src/hooks/useServiceCatalog.ts` — NEW file (mirrors `useServiceTechnologies.ts`)
- `src/hooks/useContractServices.ts` — NEW file (add/patch/delete per contract)
- `src/pages/customers/settings/ServiceCatalogBody.tsx` — NEW (clone of DeviceTypesBody + adjustments)
- `src/pages/customers/settings/ServiceCatalogBody.module.css` — NEW
- `src/pages/customers/CustomersSettingsPage.tsx` — add "Servicios" tab with `ServiceCatalogBody`, gated by `clients.manage`

---

## Approaches

### Approach A: Contract Cards + Inline Services Section
Replace the flat table with expandable contract cards. Each card shows: name/plan header, address, service chips, a collapsible "Servicios" section (add/remove from catalog), and the existing `ServiceInventorySection` (equipment). Modal for editing contract name.

- Pros: rich UX; matches user requirement; services and equipment visually co-located per contract; no nested tables; impeccable-compliant (cards only when truly the best affordance — here they ARE the best affordance as each contract is a self-contained entity with multiple sub-sections)
- Cons: more JSX complexity; cards are banned when used lazily (but NOT when they're semantically correct — contract-as-card is correct)
- Effort: Medium

### Approach B: Keep Table + Panels Below
Keep the contracts table, add a panel that expands below the selected row (accordion) to show services + equipment.

- Pros: familiar table layout; less code
- Cons: doesn't scale when each row has multiple sub-sections; accordion inside table is brittle; doesn't surface installation address well; harder to scan
- Effort: Medium

### Approach C: Split View — Contract List + Detail Panel
Left column: contract list. Right panel: contract detail (services, equipment, address, edit form).

- Pros: information-dense; all details visible for selected contract
- Cons: overkill for a tab inside a customer detail page; too much horizontal real estate consumed; harder to implement responsive; more state management
- Effort: High

### Recommendation
**Approach A** — Contract Cards with per-contract sections. Each contract renders as a bordered card (not a grid of identical cards — they vary by content). Card header = `name ?? plan` + status pill + address. Body sections: `Servicios del catálogo` (pill chips, add from dropdown, remove with confirm) + `Equipos instalados` (reuse `ServiceInventorySection`, but remove the side-stripe border and re-skin). Footer: Edit name / Delete contract actions.

Empty state when no contracts: dashed placeholder with "Agregar contrato" CTA.

---

## Impeccable Rules Inventory (relevant for #42)

The following impeccable design laws apply directly to this change:

1. **Cards as affordance**: Cards are NOT the lazy answer here — a contract IS a self-contained entity with multiple subsections. Using cards is the correct structural choice.
2. **No side-stripe borders** (absolute ban): `ServiceInventorySection` currently uses `borderLeft: '3px solid #e5e7eb'`. Must be removed. Replace with background tint or no separator.
3. **No identical card grids**: Cards MUST vary in content density based on what's configured (services, equipment). Use consistent structure but varying content.
4. **Empty states**: dashed border + instructional copy; invite action when `clients.write` held; informational only otherwise.
5. **Status pills**: HSL system (page is HSL-based). `active` → blue; `inactive` → gray. Padding `3px 8px; border-radius: 100px; font-size: 12px`.
6. **Typography hierarchy**: Contract name/plan at 14-15px/600; address at 13px/400/secondary; section labels at 11-12px/600/uppercase; chips at 12px/500.
7. **Copy**: Every label earns its place. "Tipo" is meaningless when we have a real name. Remove "Tipo" column entirely. "Agregar al contrato" → "Agregar servicio".
8. **Spacing rhythm**: Vary padding — card header 16px, section body 12px padding, chip gaps 6px. Avoid monotony.
9. **No modal as first thought**: Editing contract name can be done inline (click-to-edit pattern) OR via a compact modal. Inline is preferable for single-field edits.
10. **Color strategy**: Restrained — tinted neutrals + one accent (indigo). Page already establishes this in `CustomerDetailPage.module.css`.

---

## Risks

1. **`Contract` type drift**: FE type doesn't have `name` or `services[]` yet. Adding them is safe (additive) but `UpdateContractData` needs `name` field too — if forgotten, the TypeScript build will pass but the PATCH won't send name.
2. **Contract ID is `number` on FE but UUID on BE**: The contract services endpoint is `/api/contracts/:contractId/services` where `contractId` is the Prisma UUID (`string`), NOT the legacy numeric Splynx ID. Must verify which `id` the FE has in the `Contract` type — currently `id: number`. If GR-synced contracts use numeric splynx IDs in the FE `id` field, the service-catalog endpoints may not resolve them. CRITICAL: needs verification before spec.
3. **No `clients.manage` gate in CustomersSettingsPage yet**: Adding ServiceCatalogBody requires wiring `clients.manage` permission check — the pattern is already there (`clients.read` gates Tecnologías).
4. **`ServiceInventorySection` has no CSS Module**: All inline styles. The redesign requires CSS Module extraction. Risk: breaking the existing equipment display if inline styles are removed without proper CSS Module coverage.
5. **`addClientContract` posts to `/clients/:id/contracts`**: This is the old flow — does it still work for creating base contracts (without services)? Yes — services are additive. But the add-contract form currently has `type` and `plan` fields hardcoded. Post-#43, `name` should be settable at creation time too — spec needs to clarify if `POST /clients/:id/contracts` accepts `name`.
6. **`buildContractLabel` not used in ContractsTab**: The helper is already written; the redesign should use it for consistency (or deprecate it in favor of `name ?? plan` directly).

---

## Ready for Proposal
Yes. All backend endpoints are shipped (#43). The FE gap is clear: missing types, missing api/hooks for 3 new endpoints, full redesign of ContractsTab, new ServiceCatalogBody in settings, and one minor addition to CustomersSettingsPage. The impeccable design direction is well-defined. Risk #2 (contract ID type) must be confirmed in the proposal by checking how `/api/clients/:id/contracts` returns the `id` field.
