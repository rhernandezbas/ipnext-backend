# Tasks — tv-register-modal (BE side)

## #2 — Invalid Date (registrationDate normalization)

- [x] Write failing tests in `GigaredClient.test.ts`:
  - `"19/01/2026"` → `"2026-01-19"`
  - `null` → `null`
  - `""` (empty) → `null`
  - `"garbage"` → `null`
  - already-ISO `"2026-01-19"` passes through
  - Update existing `listAccounts` assertion from `'19/01/2026'` to `'2026-01-19'`
- [x] Add `normalizeRegistrationDate(raw)` helper in `GigaredClient.ts`
- [x] Wire `normalizeRegistrationDate` in `mapAccount`
- [x] Update all `fakeAccount` fixtures in test files using `'19/01/2026'` → `'2026-01-19'`

## #3 — Broken customer link (clientId derivation)

- [x] Add `clientId: string | null` to `GigaredAccount` interface in `GigaredPort.ts`
- [x] Write failing tests in `GigaredClient.test.ts`:
  - `"uuid-1"` → `clientId "uuid"`
  - bare `"uuid"` → `clientId "uuid"`
  - `null` internalId → `null` clientId
  - UUID with embedded hyphens + suffix → correct stripping
- [x] Add `deriveClientId(internalId)` helper in `GigaredClient.ts`
- [x] Wire `deriveClientId` in `mapAccount`
- [x] Write failing tests for `ListGigaredAccounts` application layer re-application
- [x] Re-apply `clientId` derivation in `ListGigaredAccounts.execute` (application layer is authoritative)
- [x] Update `fakeAccount` helpers in all affected test files to include `clientId`
- [x] Update port shape witness in `gigared-ports.test.ts`

## Verification

- [x] `npx jest gigared --runInBand`: 250 tests / 13 suites — all pass
- [x] `npx tsc --noEmit`: clean
