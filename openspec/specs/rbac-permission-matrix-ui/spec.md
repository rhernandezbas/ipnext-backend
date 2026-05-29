# Spec: rbac-permission-matrix-ui

## Capability
Permission matrix editor — replaces the existing "roles" tab content in
`AdminPage.tsx` with a full RBAC management interface.

**Artifact store**: engram only (FE has no openspec directory).
This file lives in the BE repo for cross-reference; canonical FE spec is in
engram at `sdd/roles-permissions-management/fe-spec`.

---

## Location in the app

File: `src/pages/admin/AdminPage.tsx` (or the roles sub-tab component within it).
Tab selector: the tab with id `'roles'` in the existing Tabs component.
Replace: whatever currently renders inside that tab with `<RbacPermissionMatrix />`.

---

## New files

```
src/api/rbac.api.ts                              (new or extend existing)
src/hooks/useRbacRoles.ts                        (new)
src/hooks/useRbacPermissions.ts                  (new — catalog)
src/hooks/useRolePermissions.ts                  (new — per-role)
src/pages/admin/components/RbacPermissionMatrix/
  index.tsx                                      (root, exported)
  RbacPermissionMatrix.module.css
  LeftRail.tsx
  LeftRail.module.css
  MatrixPanel.tsx
  MatrixPanel.module.css
  MatrixRow.tsx           (one module group row)
  MatrixRow.module.css
  MatrixCell.tsx          (one checkbox cell)
  NewRoleModal.tsx
  NewRoleModal.module.css
src/__tests__/pages/admin/RbacPermissionMatrix.test.tsx
```

---

## API layer (`src/api/rbac.api.ts`)

```ts
export const rbacApi = {
  listRoles: (): Promise<{ roles: RbacRole[] }> =>
    axiosClient.get('/admin/rbac/roles').then(r => r.data),

  listPermissions: (): Promise<{ permissions: RbacPermissionItem[] }> =>
    axiosClient.get('/admin/rbac/permissions').then(r => r.data),

  getRolePermissions: (roleId: string): Promise<{ permissions: RbacPermissionItem[] }> =>
    axiosClient.get(`/admin/rbac/roles/${roleId}/permissions`).then(r => r.data),

  setRolePermissions: (roleId: string, permissionIds: string[]) =>
    axiosClient.put(`/admin/rbac/roles/${roleId}/permissions`, { permissionIds })
      .then(r => r.data),

  createRole: (data: { code: string; label: string; description?: string }) =>
    axiosClient.post('/admin/rbac/roles', data).then(r => r.data),

  deleteRole: (roleId: string) =>
    axiosClient.delete(`/admin/rbac/roles/${roleId}`).then(r => r.data),
};
```

Types:
```ts
export interface RbacPermissionItem {
  id: string;
  moduleCode: string;
  action: string;
  moduleLabel: string;
}
```

---

## Hooks

### `useRbacRoles`
```ts
useQuery({ queryKey: ['rbac', 'roles'], queryFn: rbacApi.listRoles, staleTime: 60_000 })
```

### `useRbacPermissions`
Full catalog. `staleTime: 10 * 60 * 1000` (catalog rarely changes).

### `useRolePermissions(roleId: string | null)`
```ts
useQuery({
  queryKey: ['rbac', 'roles', roleId, 'permissions'],
  queryFn: () => rbacApi.getRolePermissions(roleId!),
  enabled: roleId != null,
  staleTime: 30_000,
})
```

### `useSetRolePermissions`
```ts
useMutation({
  mutationFn: ({ roleId, permissionIds }) => rbacApi.setRolePermissions(roleId, permissionIds),
  onSuccess: (_, { roleId }) => {
    qc.invalidateQueries(['rbac', 'roles', roleId, 'permissions']);
    qc.invalidateQueries(ME_PERMISSIONS_QUERY_KEY);   // invalidate /me if own role
  }
})
```

---

## Component: `RbacPermissionMatrix` (root)

Layout: 2-column flex (`min-height: calc(100vh - 120px)`).
- Left: `<LeftRail />` (fixed width ~260px, scrollable)
- Right: `<MatrixPanel />` (flex-grow: 1, scrollable independently)

State (local):
```ts
const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
const [dirtyPermIds, setDirtyPermIds] = useState<Set<string> | null>(null);
// null = not dirty; Set = pending changes
```

---

## Component: `<LeftRail />`

### Content
- Header: "Roles" heading + "Nuevo rol" button (top-right).
- Role list: one row per role.
  - System roles show a badge "Sistema" (pill, `var(--color-neutral-200)`).
  - Custom roles have a delete icon (appears on hover via CSS `:hover`).
  - Selected role: highlighted row (`var(--color-primary-50)` bg, left border accent).
- Click on a role: sets `selectedRoleId`, resets `dirtyPermIds` to null.

### "Nuevo rol" modal
Triggers `<NewRoleModal />` overlay.
Fields: code (required, lowercase alphanumeric + underscore), label (required),
description (optional).
Validation: code must be unique (FE checks against loaded roles list; BE returns
409 on conflict).

### Delete role (custom only)
- Shown only for roles where `isSystem === false`.
- Clicking trash: opens `window.confirm("¿Eliminar el rol «{label}»? Esta acción no se puede deshacer.")`.
- On confirm: calls `rbacApi.deleteRole(roleId)`, invalidates `['rbac', 'roles']`.
- On error: shows inline error message in LeftRail.

### Accessibility
- Role list: `<ul role="listbox" aria-label="Lista de roles">`.
- Each item: `<li role="option" aria-selected={selected}>`.
- "Nuevo rol" button: `aria-label="Crear nuevo rol"`.

---

## Component: `<MatrixPanel />`

### Empty state
When `selectedRoleId === null`:
- Centered card: icon (grid/permission icon) + "Seleccioná un rol para editar sus permisos."

### Loading state
When `useRolePermissions` is loading:
- 6 shimmer rows (height 48px each, `var(--color-neutral-100)` animated gradient).

### Normal state
Structure:
```
[Sticky header bar: role name + description + save/discard buttons]
[Search input: filters module rows by code/label]
[Matrix table: modules × actions]
```

#### Sticky header bar
- Role name (H3 or large label).
- If custom role: name is editable inline (click-to-edit or text input always visible).
- "Guardar cambios" button: disabled unless `dirtyPermIds !== null`.
- "Descartar" button: shown only when dirty; resets `dirtyPermIds` to null.
- Position: `position: sticky; top: 0; z-index: 10; background: var(--color-surface)`.
- Accessibility: `aria-label="Barra de acciones del rol"`.

#### Search
- `<input type="search" placeholder="Filtrar módulos..." aria-label="Buscar módulos">`.
- Filters matrix rows by `moduleCode` OR `moduleLabel` (case-insensitive).
- Clears on role change.

#### Matrix table
- Rendered as `<table role="grid">`.
- Column headers: one `<th>` per unique action across ALL permissions (sorted:
  base actions first: read, write, delete, manage; then sub-actions alphabetically).
- Each module = one `<tr>` (module group row).
  - First cell: module label + bulk shortcuts ("Todo" / "Ninguno" buttons).
  - Remaining cells: one `<td>` per action column; contains a checkbox if that
    `(moduleCode, action)` combination exists in the catalog; empty cell otherwise.
- Super_admin selected:
  - All checkboxes are `checked + disabled`.
  - Row has a grey tint (`var(--color-neutral-50)`).
  - Tooltip: "Acceso total — el rol super_admin no puede ser modificado".

#### Checkbox interaction
- Toggle: updates `dirtyPermIds` (clone current granted set, add/remove the permissionId).
- Initial granted set comes from `useRolePermissions(selectedRoleId)`.

#### Bulk shortcuts per module
Two micro-buttons beside module label:
- "Todo": checks all permissions in that module group.
- "Ninguno": unchecks all permissions in that module group.
- Only visible on hover of the module row (CSS `:hover`).

#### Save flow
1. User clicks "Guardar cambios".
2. Call `useSetRolePermissions.mutateAsync({ roleId: selectedRoleId, permissionIds: [...dirtyPermIds] })`.
3. On success: show success banner ("Permisos actualizados correctamente") for 3s.
   Reset `dirtyPermIds` to null. Invalidate queries (see hook above).
4. On error `SUPER_ADMIN_IMMUTABLE`: show error banner (should not normally reach
   this — UI disables editing for super_admin already).
5. On other error: show error banner with message.

#### Dirty state navigation warning
If `dirtyPermIds !== null` and user clicks a different role in LeftRail:
- Show `window.confirm("Hay cambios sin guardar. ¿Salir sin guardar?")`.
- On confirm: switch role, reset dirty state.
- On cancel: stay on current role.

---

## Visual hierarchy (IMPECCABLE)

- Left rail: subtle border-right, `var(--color-neutral-100)` bg.
- Matrix table: compact rows (height: 40px), alternating row background
  (`var(--color-neutral-25)` on odd rows).
- Column headers: `font-size: var(--font-size-xs); font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--color-neutral-500)`.
- Module label cells: `font-weight: 500; color: var(--color-neutral-800)`.
- Checkboxes: `accent-color: var(--color-primary-500)`.
- Super_admin row: `opacity: 0.7; cursor: not-allowed` on checkboxes.
- Badges: pill shape, small font, system badge in `var(--color-neutral-200)`.
- Shimmer: `@keyframes shimmer` from `var(--color-neutral-100)` to
  `var(--color-neutral-200)` and back.

### Keyboard navigation
- Tab through matrix cells (each checkbox is naturally focusable).
- Arrow keys on role list (implement `onKeyDown` in LeftRail for up/down navigation).
- Enter/Space on role list item: select.
- Esc: close NewRoleModal.

---

## Scenarios (= test cases)

### S1 — initial load + select role
```
Given: 6 roles in DB, "tecnico" has [scheduling.read, scheduling.write]
When:  RbacPermissionMatrix renders + user clicks "tecnico"
Then:  MatrixPanel shows "tecnico" in header
And:   scheduling.read and scheduling.write checkboxes are checked
And:   scheduling.delete is unchecked
```

### S2 — edit checkboxes → dirty state
```
Given: role selected, no dirty state
When:  user checks "scheduling.delete" checkbox
Then:  "Guardar cambios" button becomes enabled
And:   "Descartar" button is visible
```

### S3 — save happy path
```
Given: dirty state with permissionIds set
When:  user clicks "Guardar cambios"
Then:  PUT /api/admin/rbac/roles/:id/permissions called with correct body
And:   on success: success banner appears
And:   dirty state is reset (buttons disabled again)
```

### S4 — super_admin row is immutable
```
Given: "super_admin" role selected
When:  MatrixPanel renders
Then:  all checkboxes are checked AND disabled
And:   "Guardar cambios" button is disabled
```

### S5 — create new role
```
Given: user clicks "Nuevo rol"
When:  modal opens + fills code="gestor", label="Gestor de clientes"
And:   submits
Then:  POST /api/admin/rbac/roles called
And:   modal closes + new role appears in LeftRail
```

### S6 — delete custom role
```
Given: custom role "gestor" exists
When:  user clicks trash icon + confirms
Then:  DELETE /api/admin/rbac/roles/:id called
And:   "gestor" removed from LeftRail
```

### S7 — search filter
```
Given: matrix showing 25 module rows
When:  user types "sched" in search
Then:  only "scheduling" row is visible
```

### S8 — dirty state warning on role switch
```
Given: role "tecnico" selected + dirty changes
When:  user clicks "noc" in LeftRail
Then:  window.confirm called with warning message
When:  user cancels
Then:  still on "tecnico", dirty state preserved
```

### S9 — loading shimmer
```
Given: useRolePermissions is loading
When:  MatrixPanel renders
Then:  shimmer rows are visible instead of table
```

### S10 — empty state (no role selected)
```
Given: no role selected
When:  RbacPermissionMatrix renders
Then:  "Seleccioná un rol" hint visible in MatrixPanel
```

### S11 — bulk "Todo" for a module
```
Given: role selected, monitoring module has 2 unchecked permissions
When:  user clicks "Todo" on monitoring row
Then:  both monitoring checkboxes become checked
And:   dirty state activated
```

### S12 — save invalidates useMyPermissions if own role
```
Given: logged-in user has role "noc"
When:  user edits "noc" permissions and saves
Then:  useMyPermissions query is invalidated (ME_PERMISSIONS_QUERY_KEY)
```
