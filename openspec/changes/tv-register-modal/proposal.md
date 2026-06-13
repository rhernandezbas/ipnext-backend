# Proposal — tv-register-modal (BE side)

## Intent

Fix two data-quality bugs in the Gigared accounts list that block the TV register modal on the FE:

1. **#2 — Invalid Date**: `registrationDate` arrives from the partner as `DD/MM/YYYY` (e.g. `"19/01/2026"`). The FE's `new Date(registrationDate)` produces `Invalid Date`. Normalize to ISO `YYYY-MM-DD` at the adapter boundary.

2. **#3 — Broken customer link**: The accounts list exposes `internalId` = the TV identity `{clientId}-{seq}` (introduced by #81). The FE needs the bare `Client.id` to build the `/clients/{id}` link, but was receiving the raw `internalId` with the suffix. Add a derived `clientId` field by stripping the trailing `-{seq}`.

## Scope

- `src/domain/ports/GigaredPort.ts` — add `clientId: string | null` to `GigaredAccount`.
- `src/infrastructure/adapters/gigared/GigaredClient.ts` — add `normalizeRegistrationDate` helper (DD/MM/YYYY → ISO, null/empty/garbage → null, already-ISO passthrough) and `deriveClientId` helper (`internalId.replace(/-\d+$/, '')`); wire both in `mapAccount`.
- `src/application/use-cases/gigared/ListGigaredAccounts.ts` — re-apply `clientId` derivation authoritatively at the application layer (don't trust adapter enrichment).
- Tests: `GigaredClient.test.ts`, `GigaredAccount.usecases.test.ts`, plus fixture updates in `gigared.routes.test.ts`, `gigared-ports.test.ts`, `AddTvService.usecase.test.ts`, `CancelTv.usecase.test.ts`, `ChangeTvPassword.usecase.test.ts`, `reconcileTvContractService.test.ts`.

## Approach

Strict TDD (red → green): failing tests written first, implementation second. No Prisma changes needed — the fix is purely at the adapter + application layer. The adapter `GigaredClient` handles the raw wire conversion; `ListGigaredAccounts` re-applies `clientId` so the FE wire contract is authoritative at the application boundary.

## Wire Contract (FE-facing delta)

```ts
interface GigaredAccount {
  // existing fields unchanged
  registrationDate: string | null  // now ISO YYYY-MM-DD (was DD/MM/YYYY from partner)
  internalId: string | null        // unchanged
  clientId: string | null          // NEW — bare Client.id (internalId suffix stripped)
}
```
