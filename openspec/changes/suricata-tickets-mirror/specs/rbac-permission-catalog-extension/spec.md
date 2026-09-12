# Delta for rbac-permission-catalog-extension

The canonical spec at `openspec/specs/rbac-permission-catalog-extension/spec.md` documents a past, already-applied migration (fixed requirement/scenario counts for a one-time catalog expansion). Its `R1-R6`/`S1-S6` requirements are not general, still-evolving behavior, so this delta does not edit them. It ADDS the general contract for extending the closed `RbacModuleCode` union going forward, plus the concrete extension this change introduces.

## ADDED Requirements

### Requirement: RBAC-EXT-1 — closed union requires a domain code change

`RbacModuleCode` MUST remain a closed TypeScript union (`RBAC_MODULES` const array). Introducing a new module code MUST require editing that domain array in code; a module inserted only into the database (seed/migration) without a matching domain code change MUST NOT be treated as a valid `RbacModuleCode` by application code.

#### Scenario: DB-only module is not a valid code

- GIVEN a `RbacModule` row seeded in the database with code `"ghost"` that was never added to `RBAC_MODULES`
- WHEN application code attempts to reference `"ghost"` as a `RbacModuleCode`
- THEN it MUST fail type-checking (`tsc --noEmit`), not silently pass

### Requirement: RBAC-EXT-2 — `suricata` module code added

`RBAC_MODULES` MUST include `'suricata'`. It MUST expose the base actions `read` and `manage`, plus one dedicated sub-action `reply` for the guarded reply action (`suricata-ticket-reply` REPLY-1) — no `write`/`delete` base actions are added, following the pattern already used for `uisp`/`news`/`promos`/`wifi`/`store`. The corresponding `RbacModule` and `RbacPermission` rows (`suricata.read`, `suricata.manage`, `suricata.reply`) MUST be inserted additively (idempotent `ON CONFLICT DO NOTHING`, same shape as the existing catalog migration) and granted to `super_admin`.

#### Scenario: module and permissions exist after migration

- GIVEN the migration for this change has run
- WHEN querying `RbacModule` for code `'suricata'`
- THEN it exists with permissions `read`, `manage`, `reply`
- AND `super_admin` holds all three

#### Scenario: re-running the migration is a no-op

- GIVEN the migration already ran once
- WHEN it runs again
- THEN no duplicate `RbacModule` or `RbacPermission` rows for `suricata` are created

### Requirement: RBAC-EXT-3 — external verdict endpoint is independent of RBAC

The `suricata-bot-verdict` external endpoint (VERDICT-1) MUST authenticate via its own dedicated API token, not via an RBAC session. `suricata.*` permissions gate the Prominense panel (list, detail, assignment, reply) only; they MUST NOT be required or checked on the external token-authenticated route.

#### Scenario: valid RBAC session does not open the external endpoint

- GIVEN a logged-in Prominense user holding `suricata.read`/`suricata.manage`/`suricata.reply`, but with no external API token
- WHEN they call the external verdict endpoint using only their session cookie
- THEN the request is rejected for lacking the dedicated token — the RBAC session is not an accepted credential there
