# Delta Spec — inventory-confirm-dedup-replace

> Follows `inventory-edit-and-match` (in prod). Converts the visual match badge into an
> enforced server-side gate with three resolutions: add, link_existing, replace.
> Strict TDD. One additive migration. Touches the live confirm flow → full suite as safety net.

---

## F1 — Shared Matcher (`matchInstalledItem` helper)

**Context:** `computeMatch` currently lives inside `ListTaskInventorySuggestions`. This feature also needs it in `ConfirmInventorySuggestion`. It MUST be extracted to a shared pure helper so the logic is defined once and both use cases call it.

**F1-1** — The matcher MUST be exported from `src/application/services/matchInstalledItem.ts` as a pure function with no side effects and no infrastructure dependencies.

> Given a `TaskInventorySuggestion` and an array of `ContractInstalledItem[]`
> When the function is called
> Then it MUST return `SuggestionMatch | null` — the same shape already produced by the inline `computeMatch` in `ListTaskInventorySuggestions`.

**F1-2** — Serial number normalisation MUST apply `trim()` then `toUpperCase()` before comparison.

> Given a suggestion with `serialNumber = "  abc123  "` and an item with `serialNumber = "ABC123"`
> When the matcher runs
> Then it MUST detect `same_device`.

**F1-3** — MAC normalisation MUST apply `trim()`, `toUpperCase()`, then strip all `:` and `-` characters before comparison.

> Given a suggestion with `mac = "aa:bb:cc:dd:ee:ff"` and an item with `mac = "AABBCCDDEEFF"`
> When the matcher runs
> Then it MUST detect `same_device`.

**F1-4** — `same_device` (SN or MAC match) MUST take precedence over `same_type` when both could match.

> Given a suggestion that matches an item by SN AND matches a different item by type
> When the matcher runs
> Then the returned status MUST be `same_device` pointing to the SN-matched item, not `same_type`.

**F1-5** — The matcher MUST only consider items whose `status` is NOT `'removed'` AND NOT `'replaced'`. Items with either of those statuses MUST be invisible to the matcher.

> Given a contract with one active item (`status='active'`) and one retired item (`status='replaced'`) of the same type
> When the matcher evaluates a suggestion of that type
> Then it MUST return `same_type` only for the active item; if the only match was the retired item it MUST return `null`.

**F1-6** — The matcher MUST only consider items of kind DEVICE. A MATERIAL suggestion MUST always return `null` without reading the item list.

> Given a suggestion with `kind='MATERIAL'`
> When the matcher runs
> Then it MUST return `null` immediately.

**F1-7** — `ListTaskInventorySuggestions` MUST delegate to the extracted helper and its observable behaviour MUST be unchanged: same DTOs, same match values, no regression.

> Given an existing suite of tests for `ListTaskInventorySuggestions`
> When the helper is extracted and `ListTaskInventorySuggestions` is updated to call it
> Then every existing test MUST still pass without modification.

---

## F2 — Confirm with Resolution (`ConfirmInventorySuggestion`)

**Context:** `ConfirmInventorySuggestion.execute` receives a new optional `resolution` field. The use case recalculates the match server-side (never trusts the FE) and routes through the locked behaviour table.

**F2-1** — `ConfirmInventorySuggestionInput` MUST accept `resolution?: 'add' | 'replace' | 'link_existing'`. When omitted or `undefined`, the effective resolution MUST default to `'add'`.

> Given a confirm call with no `resolution` field
> When the use case executes
> Then it MUST behave identically to `resolution='add'`.

**F2-2** — On DEVICE suggestion with match `same_device` and effective resolution `'add'`: the use case MUST throw `DuplicateInstalledItemError` (code `DUPLICATE_INSTALLED_ITEM`) and MUST NOT create any `ContractInstalledItem`.

> Given a suggestion of kind DEVICE whose SN matches an active installed item
> When `execute` is called with `resolution='add'` (or no resolution)
> Then a `DuplicateInstalledItemError` MUST be thrown and zero items MUST be created.

**F2-3** — On DEVICE suggestion with match `same_device` and resolution `'link_existing'`: the use case MUST call `suggestions.setStatus(id, 'confirmed', existingItem.id)` and MUST NOT call `inventory.create`. The result MUST be `{ kind: 'DEVICE', item: <existing item DTO> }`.

> Given a suggestion of kind DEVICE whose MAC matches active item `X`
> When `execute` is called with `resolution='link_existing'`
> Then `inventory.create` MUST NOT be called, `setStatus` MUST be called with `confirmedItemId = X.id`, and the returned item MUST equal the DTO of `X`.

**F2-4** — On DEVICE suggestion with match `same_type` and resolution `'add'`: the use case MUST create a new item normally. Both the existing matched item and the new item are left active (coexist).

> Given a suggestion of kind DEVICE whose type matches active item `Y` but SN and MAC differ
> When `execute` is called with `resolution='add'`
> Then a new item MUST be created; item `Y` MUST remain `status='active'`.

**F2-5** — On DEVICE suggestion with match `same_type` and resolution `'replace'`: the use case MUST (a) update the matched item to `status='replaced'`; (b) create a new item with `status='active'` and `replacesItemId` set to the matched item's `id`; (c) call `suggestions.setStatus(id, 'confirmed', newItem.id)`. The result MUST be `{ kind: 'DEVICE', item: <new item DTO> }`.

> Given a suggestion of kind DEVICE whose type matches active item `Z`
> When `execute` is called with `resolution='replace'`
> Then `inventory.update(Z.id, { status: 'replaced' })` MUST be called, a new item MUST be created with `replacesItemId = Z.id`, and the new item's status MUST be `'active'`.

**F2-6** — On DEVICE suggestion with no match (`null`) and any resolution: the use case MUST create a new item (existing behaviour). Resolution values `'replace'` and `'link_existing'` with no match MUST be treated as `'add'` (no-op guard; no items to retire or link).

> Given a suggestion with no SN, MAC, or type match against any active installed item
> When `execute` is called with `resolution='replace'`
> Then a new item MUST be created; no item MUST be updated.

**F2-7** — On MATERIAL suggestions: the `resolution` field MUST be ignored. The existing material handling path MUST be followed without change.

> Given a suggestion of kind MATERIAL
> When `execute` is called with any `resolution` value
> Then the material consumption path MUST execute unchanged; `resolution` MUST have no effect.

**F2-8** — `DuplicateInstalledItemError` MUST be a named `DomainError` subclass in `src/domain/errors/inventory.ts` with code `DUPLICATE_INSTALLED_ITEM`.

> Given the error is instantiated with an existing item id
> Then `error.code` MUST equal `'DUPLICATE_INSTALLED_ITEM'` and `error instanceof DomainError` MUST be `true`.

---

## F3 — Domain Model: `replacesItemId` on `ContractInstalledItem`

**F3-1** — `ContractInstalledItem` MUST gain a `replacesItemId: string | null` field (additive, nullable). No existing field is renamed or removed.

> Given an existing `ContractInstalledItem` created before this change
> When it is read from the repository
> Then `replacesItemId` MUST be `null` (default for existing rows).

**F3-2** — The Prisma schema MUST add `replacesItemId String?` to the `ContractInstalledItem` model via a new additive migration. The migration MUST NOT alter or drop any existing column.

> Given an existing database with `ContractInstalledItem` rows
> When the migration runs
> Then all existing rows MUST be readable with `replacesItemId = null`; no data loss occurs.

**F3-3** — `ContractInventoryRepository.create` and `.update` MUST accept `replacesItemId` as an optional field. Callers that omit it receive `null` by default.

> Given a `create` call that does not pass `replacesItemId`
> When the item is persisted and read back
> Then `item.replacesItemId` MUST be `null`.

---

## F4 — Routes and Permission Guards

**Context:** `replace` is a destructive action (retires an item) and MUST be gated behind `inventory.write`. `add` and `link_existing` continue through the existing `scheduling.write`-gated confirm route. The route layer enforces this split; the use case trusts the route to have already enforced it.

**F4-1** — The existing confirm route `POST /scheduling/:taskId/inventory/suggestions/:suggestionId/confirm` MUST accept an optional `resolution` body field. It MUST pass `resolution` to `ConfirmInventorySuggestion.execute`. Guard remains `scheduling.write` (`perms.taskWrite`).

> Given a request to the confirm route with body `{ resolution: 'link_existing' }`
> When the route handler runs
> Then `execute` MUST be called with `resolution='link_existing'`.

**F4-2** — The confirm route MUST reject `resolution='replace'` with `400 INVALID_RESOLUTION` before calling the use case. Replace MUST use its own dedicated route.

> Given a request to the confirm route with `{ resolution: 'replace' }`
> When the handler runs
> Then the response MUST be `400` with `{ code: 'INVALID_RESOLUTION' }` and the use case MUST NOT be called.

**F4-3** — A new route `POST /scheduling/:taskId/inventory/suggestions/:suggestionId/replace` MUST be created, gated with `perms.contractWrite` (`inventory.write`). It calls `ConfirmInventorySuggestion.execute` with `resolution='replace'`.

> Given a user with `inventory.write` permission
> When they call `POST .../replace`
> Then `execute` MUST be called with `{ suggestionId, resolution: 'replace', addedByUserId }`.

**F4-4** — The replace route MUST return `403` for callers without `inventory.write`. The `scheduling.write`-only guard MUST NOT grant access to this route.

> Given a user who has `scheduling.write` but NOT `inventory.write`
> When they call `POST .../replace`
> Then the response MUST be `403`.

**F4-5** — The `DuplicateInstalledItemError` thrown by the use case MUST be mapped to `409` in the route error handler of the confirm route (and the replace route if applicable).

> Given the use case throws `DuplicateInstalledItemError`
> When Express's error handler processes it
> Then the HTTP response MUST be `409` with `{ error: "...", code: "DUPLICATE_INSTALLED_ITEM" }`.

---

## F5 — FE: SuggestionCard Buttons by Match

**Context:** The FE reads the `match` field already returned by `GET /scheduling/:taskId/inventory/suggestions`. Button rendering is conditional on `match.status` and on the user's permissions. No new endpoints are needed in the FE; only the button logic and the API calls change.

**F5-1** — When `match.status === 'same_device'`, the SuggestionCard MUST render exactly two actions: "Marcar como ya instalado" and "Descartar". The generic "Confirmar" button MUST NOT be shown.

> Given a SuggestionCard with `match.status = 'same_device'`
> When the card renders
> Then the "Confirmar" button MUST NOT be present; "Marcar como ya instalado" MUST be present.

**F5-2** — "Marcar como ya instalado" MUST call the confirm endpoint with `{ resolution: 'link_existing' }` (and the optional `typeOverride` if applicable).

> Given a user clicks "Marcar como ya instalado"
> When the mutation fires
> Then the HTTP body MUST include `resolution: 'link_existing'`.

**F5-3** — When `match.status === 'same_type'`, the SuggestionCard MUST render "Agregar" and, if the user has `inventory.write`, also "Reemplazar la actual". The generic "Confirmar" button MUST NOT be shown.

> Given a SuggestionCard with `match.status = 'same_type'` and a user without `inventory.write`
> When the card renders
> Then "Agregar" MUST be present and "Reemplazar la actual" MUST NOT be present.

> Given a SuggestionCard with `match.status = 'same_type'` and a user with `inventory.write`
> When the card renders
> Then both "Agregar" and "Reemplazar la actual" MUST be present.

**F5-4** — "Agregar" (same_type context) MUST call the confirm endpoint with `{ resolution: 'add' }`.

> Given a user clicks "Agregar" on a same_type card
> When the mutation fires
> Then the HTTP body MUST include `resolution: 'add'`.

**F5-5** — "Reemplazar la actual" MUST call the dedicated replace endpoint `POST .../replace` (not the confirm endpoint).

> Given a user clicks "Reemplazar la actual"
> When the mutation fires
> Then the request MUST go to `.../replace`, not `.../confirm`.

**F5-6** — When `match` is `null` (no match), the SuggestionCard MUST render the standard "Confirmar" button. It MUST call the confirm endpoint with no `resolution` field (or `resolution: 'add'`).

> Given a SuggestionCard with `match = null`
> When the card renders
> Then "Confirmar" MUST be present; "Marcar como ya instalado" and "Reemplazar la actual" MUST NOT be present.

**F5-7** — After any of the three resolution actions completes successfully, the FE MUST invalidate both the suggestions query (for the task) and the contract inventory query (for the contract). This ensures both lists refresh.

> Given a user completes "Marcar como ya instalado", "Agregar", or "Reemplazar la actual"
> When the mutation's `onSuccess` fires
> Then the suggestions query for `taskId` AND the installed items query for `contractId` MUST be invalidated (re-fetched).

**F5-8** — If the confirm route returns `409 DUPLICATE_INSTALLED_ITEM`, the FE MUST display a user-visible error message and MUST NOT crash or silently ignore the response.

> Given the backend returns `409` with `{ code: 'DUPLICATE_INSTALLED_ITEM' }`
> When the mutation's `onError` fires
> Then an error notification or inline message MUST be shown to the user.
