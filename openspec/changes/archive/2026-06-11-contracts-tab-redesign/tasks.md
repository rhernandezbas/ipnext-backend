# Tasks: contracts-tab-redesign (#42 — FE only)

## Wire Contract (reference)
```
GET /api/clients/:id/contracts → Contract[] (id: UUID string, services[] embedded)
PATCH /api/contracts/:id { name? } → { id, name }
POST /api/contracts/:contractId/services → ContractService | 409 | 422
PATCH /api/contracts/:contractId/services/:id { status?, notes? } → ContractService
DELETE /api/contracts/:contractId/services/:id → 204
GET /api/service-catalog[?active=true] → ServiceCatalogEntry[]
POST /api/service-catalog → 201 | 409 SERVICE_CATALOG_NAME_CONFLICT
PATCH /api/service-catalog/:id → 200 | 409 | 404
DELETE /api/service-catalog/:id → 204 | 422 SERVICE_IN_USE | 422 SERVICE_CATALOG_NON_DELETABLE
```

---

## Phase 1: Types + Drift Fix + Call Sites (CTU-1, CTU-2) ≤90min

- [x] 1.1 `src/types/customer.ts` — `Contract.id: string`; add `name?: string|null`, `ip?: string|null` (drop `ipAddress`), `services: ContractService[]`; add `ContractService`, `ServiceCatalogEntry`; remove `AddContractData`/`UpdateContractData`/deprecated aliases.
- [x] 1.2 `src/lib/buildContractLabel.ts` — widen `ContractLabelInput.id` to `string | number` (template-literal compatible). Scenarios: CTU-1.2.
- [x] 1.3 Fix scheduling fixtures `id` drift — `src/__tests__/scheduling/{CustomerSidebar,DatosForm,CreateTaskModal,CreateTaskModal.network}.test.tsx`: change numeric contract `id` to `'c1'` (string). Runtime already uses `String(s.id)` — mechanical only.
- [x] 1.4 [RED] `npx vitest run` — confirm type errors and call-site failures surface. `npm run typecheck` passes after 1.1–1.3 landed. Scenarios: CTU-1.2.

---

## Phase 2: Data Layer — APIs + Hooks + Wire Tests (CTU-3..6) ≤90min

- [x] 2.1 Create `src/api/service-catalog.api.ts` — `list(activeOnly?)`, `create`, `patch` (not PUT), `remove`. Mirror `deviceTypes.api.ts` structure.
- [x] 2.2 Create `src/api/contract-services.api.ts` — `add(contractId, payload)`, `update(contractId, id, payload)`, `remove(contractId, id)`.
- [x] 2.3 Modify `src/api/customers.api.ts` — add `patchContractName(id: string, name: string|null)`; remove `addClientContract`/`updateClientContract`/`deleteClientContract` + deprecated aliases.
- [x] 2.4 Create `src/hooks/useServiceCatalog.ts` — key `['service-catalog']`; variant `(activeOnly: true)` → key `['service-catalog','active']`; mutations invalidate prefix `['service-catalog']`.
- [x] 2.5 Create `src/hooks/useContractServices.ts` — `useAddContractService(clientId)`, `useUpdateContractService(clientId)`, `useRemoveContractService(clientId)`. All invalidate `['client-contracts', clientId]`.
- [x] 2.6 Modify `src/hooks/useCustomers.ts` — add `useUpdateContractName`; remove `useAdd/Update/DeleteContract`; remove `useAdd/Update/DeleteService`/`useClientServices` aliases.
- [x] 2.7 [RED→GREEN] `src/__tests__/api/serviceCatalog.api.test.ts` — assert exact URL/verb/payload via `vi.mock('@/api/axios-client')` (pattern: `createTaskFromTicket.api.test.ts`). Covers list, create (POST), patch (PATCH not PUT), delete.
- [x] 2.8 [RED→GREEN] `src/__tests__/api/contractServices.api.test.ts` — assert POST/PATCH/DELETE URLs with `:contractId`/`:id`.
- [x] 2.9 [RED→GREEN] `src/__tests__/api/customers.api` — extend with `patchContractName(uuid, name)` wire assertion.

---

## Phase 3: ServiceInventorySection CSS Module Extraction (CTU-8) ≤60min

- [x] 3.1 [GATE] Run `npx vitest run src/__tests__/customers/ServiceInventorySection.test.tsx` — confirm green baseline before touching the file.
- [x] 3.2 Create `src/pages/customers/tabs/ServiceInventorySection.module.css` — 1:1 move of all inline styles; remove `borderLeft` side-stripe entirely.
- [x] 3.3 Modify `src/pages/customers/tabs/ServiceInventorySection.tsx` — replace inline `style={}` with CSS Module classes; import new `.module.css`.
- [x] 3.4 [GATE] Re-run `ServiceInventorySection.test.tsx` — MUST remain green. Scenarios: CTU-8.1, CTU-8.2.

---

## Phase 4: Contract Cards UI (CTU-3, CTU-4, CTU-5, CTU-7) ≤90min

- [x] 4.1 Create `src/pages/customers/tabs/contracts/ContractCard.module.css` — card tokens (`--color-surface`, `--color-border`, `--radius-lg`), header, metadata, chips section, equipment section. No `borderLeft`. No inline styles.
- [x] 4.2 Create `src/pages/customers/tabs/contracts/InlineNameEdit.tsx` — click-to-edit; Enter saves via `useUpdateContractName`; Esc cancels; empty → `name: null`. Read-only when no `clients.write`. Scenarios: CTU-4.1–4.4.
- [x] 4.3 Create `src/pages/customers/tabs/contracts/ContractServiceChips.tsx` — chip per `ContractService` (active/inactive via `--badge-*` tokens); toggle on click; "×" with `useConfirm`; read-only without `clients.write`. Scenarios: CTU-5.3–5.6.
- [x] 4.4 Create `src/pages/customers/tabs/contracts/ServicePickerMenu.tsx` — popover (outside-click pattern from `KebabMenu`); catalog `?active=true` filtered to exclude already-added ids; calls `useAddContractService`; 409 → `mapError` toast. Scenarios: CTU-5.1, CTU-5.2, CTU-5.5.
- [x] 4.5 Create `src/pages/customers/tabs/contracts/ContractCard.tsx` — assembles `InlineNameEdit` + metadata (`ip`, address with "INSTALACIÓN" label, technology, dates) + `ContractServiceChips` + `ServicePickerMenu` button + `ServiceInventorySection`. `StatusBadge` for pill. Scenarios: CTU-3.1–3.3, CTU-7.2–7.3.
- [x] 4.6 Rewrite `src/pages/customers/tabs/ContractsTab.tsx` — container: `useClientContracts`; maps to `ContractCard ×N`; empty state `.placeholder` "Este cliente no tiene contratos." / "Los contratos se sincronizan desde Gestión Real." (no CTA). Scenarios: CTU-6.1, CTU-7.1.
- [x] 4.7 Create/update `src/pages/customers/tabs/ContractsTab.module.css` — cards stack, gap tokens, placeholder style.
- [x] 4.8 [RED→GREEN] `src/__tests__/customers/ContractsTab.test.tsx` — DOM tests: name/plan fallback, ip field, address label, chips, empty state no CTA; name edit Enter calls `patchContractName(uuid)`; add/toggle/remove + invalidation; permission gates via `mockPerms` pattern. Scenarios: CTU-3..7 (all).

---

## Phase 5: Removals + Cleanup (CTU-6) ≤45min

- [x] 5.1 Delete `src/pages/customers/tabs/ServicesTab.tsx` and `src/__tests__/customers/ServicesTab.test.tsx`. Scenarios: CTU-6.2.
- [x] 5.2 Modify `src/__tests__/customers/CustomerDetailPage.test.tsx` — remove mocks for deleted hooks (`useAddContract`, `useUpdateContract`, `useDeleteContract`). Lines 99-112 per design callout.
- [x] 5.3 [GATE] `npm run typecheck` — zero errors. `npx vitest run` — full suite green.

---

## Phase 6: ServiceCatalogBody — Settings Tab (CTU-9) ≤90min

- [x] 6.1 Create `src/pages/customers/settings/ServiceCatalogBody.tsx` — clone `DeviceTypesBody`; use `useServiceCatalog` + mutations; PATCH (not PUT); labels "servicio"; delete guards: 422 `SERVICE_IN_USE` → toast "hay contratos que usan este servicio"; 422 `SERVICE_CATALOG_NON_DELETABLE` → toast "OTROS no se puede eliminar"; create/update 409 `SERVICE_CATALOG_NAME_CONFLICT` → toast keep modal open.
- [x] 6.2 Create `src/pages/customers/settings/ServiceCatalogBody.module.css` — clone `DeviceTypesBody.module.css` density tokens.
- [x] 6.3 Modify `src/pages/customers/CustomersSettingsPage.tsx` — add tab `{ id: 'servicios', label: 'Servicios' }` gated `can('clients.manage')`; lazy-load `ServiceCatalogBody`; hash-sync `#servicios`.
- [x] 6.4 [RED→GREEN] `src/__tests__/customers/ServiceCatalogBody.test.tsx` — list, create, 409 modal stays open, delete 422×2 guards, `clients.manage` gating. Scenarios: CTU-9.1–9.4.
- [x] 6.5 [RED→GREEN] extend `CustomersSettingsPage.test.tsx` — "Servicios" tab visible with `clients.manage`; hidden without; hash `#servicios` activates tab. Scenarios: CTU-9.1, CTU-9.2, CTU-9.5.

---

## Phase 7: Gates + Final Verification ≤30min

- [x] 7.1 `npx vitest run` — all suites green (no regressions).
- [x] 7.2 `npm run typecheck` — zero errors.
- [x] 7.3 Visual spot-check: no `borderLeft` inline styles in any component touched; chips use `--badge-*` tokens; `StatusBadge` pill present on each card header.
- [x] 7.4 Verify `buildContractLabel` is called (or explicitly deprecated, not duplicated) across contract display paths.
