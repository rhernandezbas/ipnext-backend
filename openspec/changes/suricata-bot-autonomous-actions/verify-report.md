```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:1462e094f841ec461e51d2b44cd958f52a72891bbc0f9a087baed110576735ac
verdict: fail
blockers: 0
critical_findings: 1
requirements: 35/39
scenarios: 39/43
test_command: npx jest --silent
test_exit_code: 1
test_output_hash: sha256:3855bcdda4d100dd57896f270ff0ef9caeb23b5ee08bbf3b6d014bf5786f2b63
build_command: npx tsc --noEmit
build_exit_code: 0
build_output_hash: sha256:eb6cba24c3350cbccceb391b912b11ab7b671ef8d4f99b0a7dabeb49ac2c8e1b
```

## Verification Report

**Change**: suricata-bot-autonomous-actions
**Version**: N/A (OpenSpec change, not versioned)
**Mode**: Strict TDD
**Artifact store**: hybrid (OpenSpec files + Engram)
**HEAD verified**: `d0a8230e` (all 8 phase commits on `main`, deployed, all 4 flags dark)

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 52 |
| Tasks complete | 52 |
| Tasks incomplete | 0 |

All 52 `tasks.md` checkboxes are `[x]`. Phase B is a human-run live capture pass with no automated
deliverable; its captured values are materialized in
`src/infrastructure/adapters/suricata/actionSelectors.ts` and
`src/domain/constants/suricataStatus.ts`, both of which exist and are referenced by shipped code.

### Build & Tests Execution

**Build**: PASSED

```text
npx tsc --noEmit
exit 0 -- zero output, zero errors
```

**Tests**: 14032 passed / 3 failed / 96 skipped

```text
npx jest --silent
Test Suites: 1 failed, 6 skipped, 1334 passed, 1335 of 1341 total
Tests:       3 failed, 96 skipped, 14032 passed, 14131 total
Snapshots:   0 total
Time:        199.873 s
jest exit code: 1
```

**The 3 failures are pre-existing and unrelated to this change.** All three live in
`src/__tests__/infrastructure/suricata-migration.test.ts` and assert the role-grant scope and seed
idempotency of the PREVIOUS change's migration
(`prisma/migrations/20261116000000_suricata_tickets_mirror_base`). Independently confirmed, not
taken from the apply-progress report:

- `git status --porcelain` on that test file and on that migration directory: both empty.
- `git log 96e502dd^..HEAD -- <test file> <migration dir>`: empty -- not one of this change's 8
  commits touches either path.
- The last commits touching the test file are `d2d14218` / `9639c768` / `9f4e7433`, all from
  `suricata-tickets-mirror`, all landed before this change's first commit `96e502dd`.
- Re-run in isolation: `npx jest src/__tests__/infrastructure/suricata-migration.test.ts` ->
  `Tests: 3 failed, 15 passed, 18 total`, exit 1 -- the same 3 assertions, not a contention artifact.

The `ticketComments.dualParser.e2e.test.ts` timeout that Phase G observed did NOT recur.

**Coverage**: not run. Coverage tooling exists (`npm run test:coverage`) but a second ~200 s
full-suite pass was not warranted for this verification. Reported as skipped, not as a failure.

### Spec Compliance Matrix

Every row was verified by reading the cited test file and confirming its assertions match what the
spec requires -- not by trusting the apply-progress notes.

#### `suricata-bot-action-audit` (7 requirements / 7 scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| EXTAUDIT-1 | every action type produces a record | `suricata-bot-action-audit.test.ts > listByTicket > EXTAUDIT-1 -- every one of the 4 action types produces exactly one record per attempt` | COMPLIANT |
| EXTAUDIT-2 | content matches the action type | `suricata-bot-action-audit.test.ts > record > EXTAUDIT-2 -- carries the exact content for each of the 4 action types, one per record` | COMPLIANT |
| EXTAUDIT-3 | audit exists even when the driver call never completes | `suricata-bot-action-audit.test.ts > record > EXTAUDIT-1/EXTAUDIT-3 -- always inserts a NEW row, provisionally outcome:"failed"` plus the four use-case ordering tests below | COMPLIANT |
| EXTAUDIT-4 | actor is the machine user, not anonymous | `suricata-bot-action-audit.test.ts > record > EXTAUDIT-4 -- carries the actor identity literal, never anonymous`; reinforced by all four use-case tests asserting `actorLogin: API_SURICATA_USER_LOGIN` | COMPLIANT (see W4) |
| EXTAUDIT-5 | outcome flips to a terminal state | `suricata-bot-action-audit.test.ts > markOutcome > EXTAUDIT-5 -- flips only outcome/completedAt/error, preserving actionType/payload/actorLogin/attemptedAt` plus `EXTAUDIT-5 -- a failed attempt carries the concrete error` | COMPLIANT |
| EXTAUDIT-6 | no deletion path exists | `suricata-bot-action-audit.test.ts > record > EXTAUDIT-6 -- a second record call for a different attempt never mutates the first (append-only)`; the port surface is `record`/`markOutcome`/`listByTicket` only, so no delete method exists to test | COMPLIANT |
| EXTAUDIT-7 | querying all actions for a ticket | `suricata-bot-action-audit.test.ts > listByTicket > EXTAUDIT-7 -- returns mixed action types for one ticket in a single call` | COMPLIANT |

**Audit-trail spot-check (the mandatory invariant).** Verified directly in all four use-case test
files, each asserting the full chain independently:

- Exactly one row per attempt: `expect(rows).toHaveLength(1)` in every success and every failure
  test of `AddSuricataInternalNote`, `ChangeSuricataTicketStatus`, `CloseSuricataTicket` and
  `SendAutonomousSuricataReply`.
- Attempt-before-send: each file has an explicit ordering test that wraps the audit repository to
  push `'audit-recorded'` and uses a spy port that pushes `'port-invoked'`, then asserts the exact
  array. Note and close assert `['audit-recorded', 'port-invoked']`; status asserts
  `['audit-recorded', 'port-invoked', 'mirror-set-status']`; reply asserts
  `['audit-recorded', 'conversation-resolved', 'port-invoked']`.
- Outcome flips only after: success tests assert `outcome: 'applied'` AND a non-null `completedAt`;
  failure tests assert the row stays `outcome: 'failed'` and that
  `SuricataBotActionFailedError.auditId` equals the surviving row's id.
- `.error` populated on failure: asserted concretely in `suricata.AddSuricataInternalNote.test.ts`
  (`expect(rows[0]?.error).toContain('post-condition marker')`) and in the repository contract
  (`EXTAUDIT-5 -- a failed attempt carries the concrete error`).
- Route level: all four `externalV1.suricata.*.routes.test.ts` files assert
  `driver failure -> 502 with auditId, audit row stays failed`.

#### `suricata-external-read` (5 requirements / 6 scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| EXTREAD-1 | missing or wrong external key | `externalV1.suricata.read.routes.test.ts > EXTREAD-1 -- missing key -> 401, no read logic executed` and `EXTREAD-1 -- wrong key -> 401`, across all three routes | COMPLIANT |
| EXTREAD-2 | list returns the same shape as the internal route | `externalV1.suricata.read.routes.test.ts > EXTREAD-2/EXTREAD-5 -- same filters/pagination -> identical shape/values as the internal route, all 4 write flags OFF` | COMPLIANT |
| EXTREAD-3 | detail parity for an existing ticket | `externalV1.suricata.read.routes.test.ts > EXTREAD-3/EXTREAD-5 -- existing ticket -> identical detail shape/values as the internal route` | COMPLIANT |
| EXTREAD-3 | unknown ticket id | `externalV1.suricata.read.routes.test.ts > EXTREAD-3 -- unknown externalId -> 404` | COMPLIANT |
| EXTREAD-4 | KPI parity | `externalV1.suricata.read.routes.test.ts > EXTREAD-4/EXTREAD-5 -- identical KPI values as the internal route, all 4 write flags OFF` | COMPLIANT |
| EXTREAD-5 | reads work while all write flags are false | the same three parity tests; `buildApps()` seeds all four `suricata-bot-*-enabled` flags explicitly `false` | COMPLIANT |

Parity is genuine, not nominal: `buildApps()` constructs ONE set of `ListSuricataTickets`,
`GetSuricataTicketDetail` and `ComputeSuricataKpis` instances and mounts them behind BOTH the
internal session+RBAC app and the external key-guarded app, then asserts
`expect(externalRes.body).toEqual(internalRes.body)`. The comparisons are not vacuous -- each is
paired with a non-empty expectation (`data` length 2, `total` 2), so an empty-versus-empty pass is
impossible.

#### `suricata-external-reply` (6 requirements / 8 scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| EXTREPLY-1 | missing or wrong external key | `externalV1.suricata.reply.routes.test.ts > EXTREPLY-1 -- missing token -> 401, before any driver call` and `EXTREPLY-1 -- the GLOBAL external-v1 key (dedicated != global) is rejected with 401` | COMPLIANT |
| EXTREPLY-2 | flag off | `externalV1.suricata.reply.routes.test.ts > EXTREPLY-2 -- flag OFF -> 403 FEATURE_DISABLED, before any driver call, independent of the verdict flag (which stays ON)` | COMPLIANT |
| EXTREPLY-2 | reply flag on, close flag off does not affect reply | `externalV1.suricata.reply.routes.test.ts > success -> 201 with auditId, driver invoked with the exact body via the resolved conversationId`, which runs with `suricata-bot-close/status/note-enabled` all unseeded, i.e. fail-closed OFF | COMPLIANT (see W1) |
| EXTREPLY-3 | request with only ticket id and text succeeds validation | `externalV1.suricata.reply.routes.test.ts > EXTREPLY-3 -- a confirm field is never read/required/validated: present-but-wrong confirm still succeeds` plus `suricata.SendAutonomousSuricataReply.test.ts > no confirm/actorId in the input contract (D4.a)` | COMPLIANT |
| EXTREPLY-3 | empty text rejected | `externalV1.suricata.reply.routes.test.ts > EXTREPLY-3 -- empty body -> 400, before any driver call and no audit row` plus `EXTREPLY-3 -- missing body field -> 400, never 500` | COMPLIANT |
| EXTREPLY-4 | successful autonomous reply | text-verbatim half: `BotpressReplyAdapter.test.ts > sendReply > walks metadata-merchant then POSTs to the Botpress Chat API with the exact verified shape` plus `externalV1.suricata.reply.routes.test.ts > success -> 201 ... driver invoked with the exact body via the resolved conversationId`. Mechanism half (`PlaywrightSuricataReply` via `SuricataSession.withSession` at high priority): no test, and none is possible -- the shipped design deliberately does not do this | PARTIAL (CRITICAL C1) |
| EXTREPLY-5 | failed send is still audited | `suricata.SendAutonomousSuricataReply.test.ts > send failure is still audited` plus `a ticket with no linked Botpress conversation is a DISTINCT failure` plus `externalV1.suricata.reply.routes.test.ts > driver failure -> 502 with auditId, audit row stays failed` | COMPLIANT |
| EXTREPLY-6 | actor recorded is the machine user | `suricata.SendAutonomousSuricataReply.test.ts > successful send reaches Botpress and is audited` asserts `actorLogin: API_SURICATA_USER_LOGIN`; the mount's `machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN)` is pinned by `suricata-composition.test.ts > el mount externo aplica machineActorMiddleware(...)` | COMPLIANT (see W4) |

#### `suricata-internal-note` (7 requirements / 7 scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| NOTE-1 | flag off blocks note posting | `externalV1.suricata.note.routes.test.ts > NOTE-1 -- flag OFF -> 403 FEATURE_DISABLED, before any driver call, independent of the verdict flag (which stays ON)`, plus two 401 tests | COMPLIANT |
| NOTE-2 | empty note text | `externalV1.suricata.note.routes.test.ts > NOTE-2 -- empty text -> 400, before any driver call and no audit row` plus `NOTE-2 -- missing text field -> 400, never 500` plus `suricata.AddSuricataInternalNote.test.ts > NOTE-2` (empty and whitespace-only) | COMPLIANT |
| NOTE-3 | unknown ticket id | `externalV1.suricata.note.routes.test.ts > NOTE-3 -- unknown ticket externalId -> 404, no audit row` plus `suricata.AddSuricataInternalNote.test.ts > NOTE-3 -- unknown externalId -> SuricataTicketNotFoundError, BEFORE any audit row exists` | COMPLIANT |
| NOTE-4 | successful note reaches real Suricata | `suricata.AddSuricataInternalNote.test.ts > NOTE-4/NOTE-6 -- valid note -> port invoked with exact text, audit row outcome applied` plus `PlaywrightSuricataInternalNote.test.ts > requests the session at high priority (NOTE-4 -- never behind the low-priority sync queue)` and `acquires and releases the shared session per call` | COMPLIANT |
| NOTE-5 | note does not touch other fields | `suricata.AddSuricataInternalNote.test.ts > NOTE-5 -- only posts the note: no other ticket field mutated by this use case` (`expect(after).toEqual(ticket)`) | COMPLIANT |
| NOTE-6 | failed note posting is still audited | `suricata.AddSuricataInternalNote.test.ts > failed note posting is still audited`, asserting `outcome: 'failed'`, `.error` containing `post-condition marker`, and the carried `auditId` | COMPLIANT |
| NOTE-7 | auto-sync fires mid-flow | none found -- implemented in `PlaywrightBrowserSession.createInternalNote`, mocked away in the driver test | **UNTESTED (C2)** |

#### `suricata-ticket-close` (7 requirements / 8 scenarios, after the CLOSE-5 correction below)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| CLOSE-1 | flag off blocks close | `externalV1.suricata.close.routes.test.ts > CLOSE-1 -- flag OFF -> 403 FEATURE_DISABLED, before any driver call, independent of the verdict flag (which stays ON)`, plus two 401 tests | COMPLIANT |
| CLOSE-2 | missing close reason | `suricata.CloseSuricataTicket.test.ts > CLOSE-2 -- non-empty close reason required` (empty and whitespace-only, port never invoked, zero audit rows) plus the route's 400 tests | COMPLIANT |
| CLOSE-3 | unknown ticket id | `suricata.CloseSuricataTicket.test.ts > CLOSE-3 -- unknown externalId -> SuricataTicketNotFoundError, BEFORE any audit row exists` plus the route's 404 test | COMPLIANT |
| CLOSE-4 | successful close reaches real Suricata | `suricata.CloseSuricataTicket.test.ts > CLOSE-4/CLOSE-6 -- valid reason -> port invoked with exact value, audit row outcome applied` plus `PlaywrightSuricataClose.test.ts > requests the session at high priority (CLOSE-4 -- never behind the low-priority sync queue)` and `acquires and releases the shared session per call (never holds it across calls)` | COMPLIANT |
| CLOSE-5 (corrected) | successful close leaves the mirror ticket untouched | `suricata.CloseSuricataTicket.test.ts > CLOSE-5 (corrected D5.a) -- close never writes the mirror ticket > successful close does not mutate any ticket field locally (no setStatus, no other write)` (`expect(after).toEqual(ticket)`) | COMPLIANT |
| CLOSE-5 (corrected) | Suricata close fails, mirror stays unchanged | `suricata.CloseSuricataTicket.test.ts > failed close is still audited > port throws -> audit row stays failed with error, SuricataBotActionFailedError carries auditId` plus `externalV1.suricata.close.routes.test.ts > driver failure -> 502 with auditId, audit row stays failed` | COMPLIANT |
| CLOSE-6 | failed close is still audited | the same two tests as the row above, asserting `outcome: 'failed'` and the carried `auditId` | COMPLIANT |
| CLOSE-7 | auto-sync fires mid-close | none found -- implemented in `PlaywrightBrowserSession.closeTicket`, mocked away in the driver test | **UNTESTED (C2)** |

#### `suricata-ticket-status` (7 requirements / 7 scenarios)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| STATUS-1 | flag off blocks status change | `externalV1.suricata.status.routes.test.ts > STATUS-1 -- flag OFF -> 403 FEATURE_DISABLED, before any driver call, independent of the verdict flag (which stays ON)`, plus two 401 tests | COMPLIANT |
| STATUS-2 | invalid status value | `suricataStatusAllowlist.test.ts` (5 tests: accepts all 10 captured values, rejects empty, rejects out-of-catalog, rejects selector-injection-shaped, case-sensitive) plus `suricata.ChangeSuricataTicketStatus.test.ts > STATUS-2` (3 cases) plus `externalV1.suricata.status.routes.test.ts > STATUS-2 -- a selector-injection-shaped status -> 400, driver never invoked` | COMPLIANT |
| STATUS-3 | unknown ticket id | `suricata.ChangeSuricataTicketStatus.test.ts > STATUS-3 -- unknown externalId -> SuricataTicketNotFoundError, BEFORE any audit row exists` plus the route's 404 test | COMPLIANT |
| STATUS-4 | successful status change reaches real Suricata | `suricata.ChangeSuricataTicketStatus.test.ts > STATUS-4/STATUS-6 -- valid status -> port invoked with exact value, audit row outcome applied, mirror updated` plus `PlaywrightSuricataStatus.test.ts > requests the session at high priority (STATUS-4 ...)` | COMPLIANT |
| STATUS-5 | Suricata status change fails, mirror stays unchanged | `suricata.ChangeSuricataTicketStatus.test.ts > STATUS-5 > port failure -> mirror status is NOT updated, setStatus never called` (asserts zero setStatus calls AND the mirror still reads `abierto`) plus `records the audit BEFORE invoking the port, and calls setStatus only AFTER the port resolves` (exact array `['audit-recorded', 'port-invoked', 'mirror-set-status']`) plus `externalV1.suricata.status.routes.test.ts > driver failure -> 502 ..., mirror status unchanged` | COMPLIANT |
| STATUS-6 | failed status change is still audited | `suricata.ChangeSuricataTicketStatus.test.ts > failed status change is still audited` | COMPLIANT |
| STATUS-7 | auto-sync fires mid-flow | none found -- implemented in `PlaywrightBrowserSession.changeTicketStatus`, mocked away in the driver test | **UNTESTED (C2)** |

**Compliance summary**: 39/43 scenarios compliant, 35/39 requirements fully compliant.

### Targeted checks the orchestrator asked for

| Check | Finding | Evidence |
|---|---|---|
| Mandatory audit trail on all 4 write actions | CONFIRMED | See the audit-trail spot-check above: 4 use-case test files, ordering asserted by exact spy arrays, with `outcome`, `completedAt`, `.error` and `auditId` all asserted |
| Four flags independently checked | CONFIRMED at source; PARTIALLY proven at runtime | `composeSuricataExternalModule.ts` declares 4 separate literal constants (`NOTE_`, `STATUS_`, `CLOSE_`, `REPLY_FEATURE_FLAG_KEY`), each read by exactly one route's own inline 403 check. At runtime each of the 4 route suites seeds ONLY its own flag, leaving the other three unseeded, and `InMemoryFeatureFlagRepository.get()` returns `null` for an unseeded key, which the routes treat as fail-closed OFF. Every 201 test therefore proves "route X works while the other three flags are OFF". The converse case design D10 explicitly names ("note ON + close OFF => 403 on close only") has no test -- see W1 |
| Internal human-reply path untouched | CONFIRMED | `suricata-composition.test.ts > la ruta interna de reply conserva sus TRES guards intactos (flag suricata-reply-enabled, RBAC requirePerm('suricata','reply'), orden auth->requireReply)`; plus `la Fase E wirea el guard conservador UnavailableSuricataReplyPort` and `Fase G -- el wiring INTERNO de ReplyToSuricataTicket queda BYTE-FOR-BYTE sin tocar`, which regex-pins `new ReplyToSuricataTicket(suricataInternalTicketRepo, suricataReplyAuditRepo, new UnavailableSuricataReplyPort())`. Independently corroborated: `git log 96e502dd^..HEAD -- src/infrastructure/http/composeSuricataModule.ts` is empty |
| Close/status ordering (audit -> port -> local write; close skips the local write) | CONFIRMED | status asserts the exact array `['audit-recorded', 'port-invoked', 'mirror-set-status']`; close asserts `['audit-recorded', 'port-invoked']` with `expect(after).toEqual(ticket)` proving no local write. `CloseSuricataTicket`'s only use of the ticket repo is `findByExternalId` |
| Threat Matrix -- selector-injection allowlist for status values | CONFIRMED, defence in depth | `isSuricataStatusValue` rejects anything outside the 10 live-captured labels (5 dedicated tests including case-sensitivity). Independently, the driver never concatenates the value into a selector: `PlaywrightBrowserSession.changeTicketStatus` calls `page.locator('#valorSelect').selectOption({ label: status })`, Playwright's structured API, not a selector string |
| Threat Matrix -- body never interpolated into a URL or selector | CONFIRMED | A repo search for `page.evaluate` under `src/infrastructure/adapters/suricata/` returns zero hits outside comments. Note text and close reason reach the DOM only through `locator(...).fill(...)` (`PlaywrightBrowserSession.ts:285` and `:406`). Reply body: `BotpressReplyAdapter.test.ts > Threat Matrix -- the reply body reaches the JSON body verbatim, NEVER interpolated into the URL` sends a hostile string containing selector syntax and a query fragment, then asserts the URL is exactly `https://api.botpress.cloud/v1/chat/messages` while the hostile string appears only in `body.payload.text` |
| 4 flags ship dark | CONFIRMED | `prisma/migrations/20261118000000_suricata_bot_actions/migration.sql` contains four `INSERT INTO "FeatureFlag" ... VALUES ('suricata-bot-{reply,close,status,note}-enabled', false, NOW()) ON CONFLICT DO NOTHING;`. No flag was flipped by this verification pass |

### Correctness (Static Evidence)

| Requirement area | Status | Notes |
|---|---|---|
| Unified append-only audit table | Implemented | `SuricataBotActionAudit` with `payload JSONB NOT NULL`, `outcome` default `'failed'`, both D1 indexes, `ON DELETE CASCADE` FK |
| Four independent dark flags | Implemented | Seeded `false` in the same additive migration, `ON CONFLICT DO NOTHING` (D2) |
| Three write ports plus the Botpress reply port | Implemented | `SuricataTicketClosePort`, `SuricataTicketStatusPort`, `SuricataInternalNotePort`, `BotpressReplyPort` -- four separate ports, per D3.a |
| Import hygiene (D7) | Implemented and enforced | `suricata-composition.test.ts > composeSuricataExternalModule.ts tiene CERO imports de config/sharedSuricataSession/bootstrap*`, a static source assertion over the FINAL file, re-run in Phase H.2 |
| Hexagonal boundaries | Clean | Use cases depend on domain ports only; no `@infrastructure` or Prisma import in any of the four new use cases; drivers depend on a narrow structural session interface |

### Coherence (Design)

| Decision | Followed? | Notes |
|---|---|---|
| D1 unified audit, `payload Json` | Yes | Schema and migration match the decided shape |
| D1.b String plus TS union, `applied` / `failed` | Yes | No Prisma enum introduced |
| D1.c `actorLogin` is a literal | Yes | Deviates from the spec's wording -- see W4 |
| D1.d audit before port, flip outside the try | Yes | Proven by the four exact-array ordering tests |
| D2 `-bot-` flag infix | Yes | Spec files corrected this pass (RECONCILIATION 1) |
| D3.a three separate ports | Yes | |
| D3.b reply is HTTP, not Playwright | Yes | Contradicts the spec text -- see CRITICAL C1 |
| D4.a `SendAutonomousSuricataReply` is a new class with no `confirm` | Yes | `ReplyToSuricataTicket` untouched |
| D5 remote first, mirror after | Yes | Proven by the status ordering array |
| D5.a close writes no mirror field | Yes | Spec corrected this pass (RECONCILIATION 2) |
| D6 no hand-authored selectors | Yes | `actionSelectors.ts` carries live-captured values with per-constant provenance comments |
| D7 registry and bootstrap isolation | Yes | Enforced by the import-hygiene test |
| D8 read use cases reused as-is | Yes | `git log` shows no change to the three use-case files |
| D10 test strategy | Mostly | The "flags are independent (note ON + close OFF)" row and the Prisma/InMemory parity execution are the two gaps -- W1 and W2 |

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD evidence reported | PASS | apply-progress carries per-phase TDD Cycle Evidence; Phase H correctly declares itself composition and documentation work with no RED/GREEN cycle |
| All tasks have tests | PASS | Every implementation task except Phase B (manual capture), H.4 and H.5 (documentation) names a test file, and every named file exists on disk |
| RED confirmed (test files exist) | PASS | All 15 test files added across phases A and C-H exist |
| GREEN confirmed (tests pass) | PASS | All of them pass in the full-suite run; zero failures outside the pre-existing migration suite |
| Triangulation adequate | PASS | Validation requirements carry 2-3 cases each (empty, whitespace-only, and for status an injection-shaped value); the allowlist has 5 distinct cases; the audit contract has 8 |
| Safety net for modified files | PASS | The two shared files edited by many phases (`composeSuricataExternalModule.ts`, `app.ts`) are pinned by `suricata-composition.test.ts`, re-run and extended in Phase H |

**TDD compliance**: 6/6 checks passed.

### Test Layer Distribution (tests added by this change)

| Layer | Files | Tool | Notes |
|-------|-------|------|-------|
| Unit (domain, entity, allowlist) | 2 (`suricataBotAction.entity.test.ts`, `suricataStatusAllowlist.test.ts`) | jest | pure functions |
| Unit (use case, in-memory ports) | 4 (`suricata.AddSuricataInternalNote`, `.ChangeSuricataTicketStatus`, `.CloseSuricataTicket`, `.SendAutonomousSuricataReply`) | jest plus InMemory adapters | no Prisma mocks, per repo rule |
| Unit (adapter, driver) | 5 (`PlaywrightSuricataInternalNote`, `PlaywrightSuricataStatus`, `PlaywrightSuricataClose`, `BotpressReplyAdapter`, `bootstrapSuricataActionPorts`) | jest plus a fake session | the real DOM layer is mocked -- see C2 |
| Contract and parity (repository) | 1 (`suricata-bot-action-audit.test.ts`) | jest, dual-adapter | the Prisma half is `describe.skip` without `DATABASE_URL_TEST` -- see W2 |
| Integration (HTTP) | 5 (`externalV1.suricata.note/status/close/reply/read.routes.test.ts`) | supertest plus real use cases plus InMemory adapters | |
| Composition (static source) | 1 (`suricata-composition.test.ts`, extended) | jest over source text | |
| E2E against live Suricata | 0 | -- | deliberate, per design D10: the live Suricata site is never touched by the suite |

### Changed File Coverage

Coverage analysis skipped -- not executed for this pass (see Build and Tests above). This is
informational and non-blocking.

### Assertion Quality

Every test file added by this change was scanned for the banned patterns.

**Assertion quality**: 0 CRITICAL, 0 WARNING -- all assertions verify real behavior.

Specifically checked and found clean:

- No tautologies anywhere.
- No orphan empty-collection assertions: every `toHaveLength(0)` is the negative side of a test whose
  positive companion in the same file and same harness asserts `toHaveLength(1)`.
- No type-only assertions standing alone: `expect.any(String)` on `auditId` is always paired with a
  value assertion on the same row or the same response.
- No ghost loops -- no assertions inside iteration over a possibly-empty collection.
- The parity comparisons in `externalV1.suricata.read.routes.test.ts` are not vacuous: each
  `toEqual(internalRes.body)` is paired with a concrete non-empty expectation, so two empty bodies
  could not pass.
- Mock/assertion ratio is healthy: the only `jest.mock` is `@infrastructure/config`, a required
  fail-fast-at-import guard per design D7; the ports are hand-written spies, not mock frameworks.

### Quality Metrics

**Linter**: not available -- no lint script in `package.json`, and running Prettier on this repo is
explicitly forbidden by project convention (no config, it would reformat everything).
**Type checker**: PASS -- `npx tsc --noEmit`, exit 0, zero errors.

---

## Reconciliation edits made during this pass

Both items the orchestrator flagged were resolved in the spec files. No code was touched:
`git diff --stat` covers `openspec/changes/suricata-bot-autonomous-actions/specs/` only
(5 files, +22 / -14).

### RECONCILIATION 1 -- flag-key naming (RESOLVED)

Replaced 17 occurrences of the stale illustrative keys
`suricata-external-{reply,close,status,note}-enabled` with the actually-implemented
`suricata-bot-{reply,close,status,note}-enabled` across 5 spec files: `suricata-external-read`,
`suricata-external-reply`, `suricata-internal-note`, `suricata-ticket-close`,
`suricata-ticket-status`.

Correction to the brief: this was **5 spec files, not 6**.
`specs/suricata-bot-action-audit/spec.md` never mentioned a flag key at all -- its own non-goal
states that the audit capability "does not decide WHETHER an action runs (flags do)" -- so it needed
no edit.

The implemented keys were verified against three independent sources before rewriting: the migration
SQL, the four `*_FEATURE_FLAG_KEY` constants in `composeSuricataExternalModule.ts`, and the four
route test files' own flag constants.

One clarifying sentence was added to EXTREPLY-2 recording why the `-bot-` infix is load-bearing
(design D2): this route must not read the pre-existing `suricata-reply-enabled` flag, which governs
the internal human route only. That independence is itself test-backed by the two
`externalV1.suricata.reply.routes.test.ts > EXTREPLY-2 -- structurally independent of the INTERNAL
suricata-reply-enabled flag` tests.

### RECONCILIATION 2 -- CLOSE-5 stale wording (RESOLVED)

`specs/suricata-ticket-close/spec.md`'s CLOSE-5 was rewritten from "Suricata write first, mirror
after" -- which asserted the mirror's `status` is set to a closed value -- to "audit-only locally;
close never writes the mirror", stating the corrected D5.a behavior: closing is its own Suricata
action, the "Cambiar Estado" catalog contains no closed value, `CloseSuricataTicket` writes no local
ticket field on success or on failure, the only local write is the audit row, and the mirror
reconciles on the next sync tick. The discarded assumption is named explicitly in the new text so the
correction is auditable rather than silent.

The capability's Purpose paragraph carried the same stale premise ("closes a ticket on BOTH sides:
the Prominense mirror's `status` field and real Suricata") and was corrected in the same pass;
leaving it would have contradicted the requirement two screens below it.

CLOSE-5 now has two scenarios instead of one, taking the change's scenario total from 42 to 43. Both
are backed by existing passing tests -- no scenario was invented without coverage:

- "successful close leaves the mirror ticket untouched" ->
  `suricata.CloseSuricataTicket.test.ts > CLOSE-5 (corrected D5.a) -- close never writes the mirror ticket`
- "Suricata close fails, mirror stays unchanged" ->
  `suricata.CloseSuricataTicket.test.ts > failed close is still audited` plus
  `externalV1.suricata.close.routes.test.ts > driver failure -> 502 with auditId, audit row stays failed`

---

## Issues Found

### CRITICAL

**C1 -- `suricata-external-reply/spec.md`'s EXTREPLY-4 contradicts the shipped implementation.**

This is a THIRD stale-spec item of exactly the same class as CLOSE-5, and it was not in the
orchestrator's brief. It was deliberately NOT edited: unlike the two authorized items, it restates a
design-level decision about which actuator reply uses, and that deserves an explicit orchestrator
nod rather than a verifier's unilateral rewrite.

EXTREPLY-4 currently reads:

> A validated, enabled reply MUST invoke `PlaywrightSuricataReply` (wired for the external
> composition only) through `SuricataSession.withSession` with `priority: 'high'`.

and its scenario ends:

> AND the call acquired the session with `high` priority, never a second browser context

Every clause of that mechanism is false of the shipped code. Per design D3.b as corrected on
2026-09-13 by Phase B.7's live verification, reply is a plain HTTP POST to
`https://api.botpress.cloud/v1/chat/messages` via `BotpressReplyAdapter`. It uses no
`PlaywrightSuricataReply`, no `SuricataSession`, no priority queue, and no browser page.
`PlaywrightSuricataReply.ts` was deliberately left as unimplemented as it already was.
`suricata-composition.test.ts` actively pins the opposite of the spec text:
`Fase G -- el mount EXTERNO construye BotpressReplyAdapter/SendAutonomousSuricataReply (plain HTTP, sin registry/bootstrap)`.

The requirement's SUBSTANCE is satisfied, and is in fact the best-evidenced part of the whole change:
the exact submitted text reaches the customer's real conversation, verified end to end on 2026-09-13
against the operator's own WhatsApp number (ticket #18923), and asserted verbatim by
`BotpressReplyAdapter.test.ts`. Nothing in production is wrong. What is wrong is the artifact.

Recommended replacement, mirroring the shape of the CLOSE-5 correction:

> ### Requirement: EXTREPLY-4 -- real delivery via the Botpress Chat API
>
> CORRECTED 2026-09-13 (design D3.b, after live verification). This requirement originally named
> `PlaywrightSuricataReply` plus `SuricataSession.withSession` at `priority: 'high'`. That mechanism
> is not reachable: the customer conversation renders inside the cross-origin, websocket-driven
> `conversation.suricata.chat` iframe, which a Playwright fill/type cannot reliably drive.
>
> A validated, enabled reply MUST instead be delivered over the Botpress Chat API
> (`POST https://api.botpress.cloud/v1/chat/messages`) through a dedicated domain port, using the
> same credential and lookup path the existing read-side `botpressMessages.ts` uses. It uses no
> browser, no `SuricataSession`, and no priority queue. On success the exact submitted text MUST
> appear in the ticket's real conversation, and a non-201 response, or one carrying no
> `message.id`, MUST raise `SuricataActionNotAppliedError` rather than resolving silently.
>
> #### Scenario: successful autonomous reply
>
> - GIVEN a validated, enabled reply request with text "Ya revisamos tu reclamo"
> - WHEN the use case executes successfully
> - THEN that exact text is POSTed verbatim in the JSON request body, never interpolated into the URL
> - AND the ticket's conversation receives it, evidenced by the returned WhatsApp message id

Every clause of that replacement is already backed by passing tests
(`BotpressReplyAdapter.test.ts`, 8 tests; `suricata.SendAutonomousSuricataReply.test.ts`, 8 tests;
`externalV1.suricata.reply.routes.test.ts`, 12 tests), so the edit adds no new coverage debt.

**This is the one condition on the verdict.** It is a documentation edit with zero code impact.

**C2 -- NOTE-7 / STATUS-7 / CLOSE-7 (auto-sync selection handling) have zero automated coverage.**

All three requirements demand the driver survive Suricata's 60-second table redraw clearing the
checkbox selection mid-flow. The behavior IS implemented: `PlaywrightBrowserSession.closeTicket` and
`.changeTicketStatus` click `autoSyncStopButton` ("Detener") before selecting the row and
`autoSyncStartButton` ("Iniciar") in a best-effort `finally` afterwards
(`PlaywrightBrowserSession.ts` lines 324, 356, 386, 418; selectors at `actionSelectors.ts:96-97`).

But no test exercises it. The three `PlaywrightSuricata{InternalNote,Status,Close}.test.ts` files
mock the session method away entirely (`closeTicket: jest.fn()`), and their own headers state that
the real DOM automation "is exercised manually". A repo-wide search for `Detener`, `Iniciar` or
`autoSync` under `src/__tests__/` returns nothing.

Strictly by the verify contract -- a spec scenario is compliant only when a covering test passed at
runtime -- these are three UNTESTED scenarios. They are NOT treated here as archive blockers, and the
reasoning is specific rather than lenient:

1. The design decided this explicitly and in advance (D10: "the live Suricata site is never touched
   by the suite"). This is a known, accepted boundary, not an oversight discovered now.
2. Nothing is exposed: all four flags ship `false`, so no driver has ever executed in production.
3. `rollout.md` already mandates the compensating control -- one hand-picked real ticket per flag
   flip, verified in the Suricata UI with the audit row read back, before the next flip.

**Therefore: `rollout.md`'s per-flag live verification IS the acceptance test for NOTE-7, STATUS-7
and CLOSE-7. No flag may be flipped without executing it, and the auto-sync behavior specifically
must be observed during that pass** -- start the action, let the 60-second redraw fire, confirm the
correct row still closes or changes. Record the result alongside the audit-row readback the rollout
doc already requires.

### WARNING

**W1 -- the four-flag independence is proven in one direction only.** Design D10's test row names
the case "note ON + close OFF => 403 on close only"; no test does that. What the suite does prove,
in all four route suites, is the other direction: route X returns 201 while the other three bot flags
are unseeded and therefore fail-closed OFF, so X is not gated by Y, Z or W. The missing direction is
structurally safe -- `composeSuricataExternalModule.ts` declares four separate literal key constants
and each route reads exactly one -- but "structurally safe" is precisely what this repo's own lessons
say not to accept in place of a test. One cheap test in any single route suite (enable note, call
`/close`, assert 403 and that the close port was never invoked) would close it.

**W2 -- `PrismaSuricataBotActionAuditRepository` has no executed test.**
`suricata-bot-action-audit.test.ts` is correctly written as a shared contract suite run against both
adapters, but the Prisma half is `describe.skip` unless `DATABASE_URL_TEST` is set, and it is not set
here -- it is part of the run's 6 skipped suites and 96 skipped tests. So EXTAUDIT-1 through
EXTAUDIT-7 are proven at runtime against the InMemory adapter only; the Prisma adapter is
`tsc`-verified and read for field parity. This follows the repo's established no-local-DB convention
and the mirror change's precedent, so it is not a regression -- but the audit trail is the one
non-negotiable guarantee in this change, and its production implementation is the untested half. The
rollout doc's audit-row readback covers this manually on the first flip; a `DATABASE_URL_TEST` lane
would cover it permanently.

**W3 -- dead option in a test harness.** `externalV1.suricata.status.routes.test.ts:61` declares
`noteFlagEnabled?: boolean` in `BuildAppOpts`, but `buildApp` never reads it and no test ever passes
it. It looks like the start of the W1 cross-flag test that was never finished. Harmless, but it
advertises coverage that does not exist -- delete it or finish it.

**W4 -- EXTAUDIT-4 and EXTREPLY-6 wording versus design D1.c.** Both spec requirements say the actor
is "resolved by `machineActorMiddleware`" and is "the real `RbacUser` behind the external API key".
Design D1.c deliberately chose otherwise: `actorLogin` is written as the `API_SURICATA_USER_LOGIN`
literal, and the middleware is defense in depth rather than the value's source. The observable
guarantee the spec actually cares about is met and tested -- never `anonymous`, never a human
identity, always the machine login -- and `machineActorMiddleware` genuinely runs at the mount,
pinned by `suricata-composition.test.ts`. This is a wording mismatch, not a behavior gap: a fourth
and much smaller reconciliation item, lowest priority of the four.

**W5 -- `externalId` is interpolated into a CSS selector.** `actionSelectors.ts:78` builds
`#tabladinamica tr[data-ticket-id="${externalId}"] input[type="checkbox"]`. Unlike the status value,
`externalId` has no allowlist. The practical mitigation is real and sufficient today: every route
resolves `ticketRepo.findByExternalId(externalId)` and returns 404 before the port is ever called, so
only an id that Suricata's own sync pipeline already wrote into the mirror can reach the driver.
Noted because the Threat Matrix analyzed the status value for exactly this hazard and did not analyze
this one.

### SUGGESTION

**S1** -- `suricata-migration.test.ts`'s 3 failures are unrelated to this change, but they have now
been red across at least six consecutive full-suite runs. A permanently red suite trains everyone to
skim past the summary line. Worth its own small fix card so the next change starts from green.

**S2** -- EXTAUDIT-6 ("no deletion path exists") is satisfied structurally, since the port exposes
only `record`, `markOutcome` and `listByTicket`, but nothing pins that. A one-line assertion that the
repository surface has no `delete` or `remove` method would make the append-only guarantee
regression-proof.

**S3** -- `rollout.md`'s "Open reconciliation items" section now describes work that is done (items 1
and 2). Update or drop it when archiving, and move C1 into it if C1 is not fixed first.

---

## Verdict

**CONDITIONAL -- not archive-ready yet. One documentation edit stands between this change and a
clean PASS.**

The implementation is sound. 52 of 52 tasks complete, `tsc --noEmit` clean, 14032 tests passing, and
the only 3 failures in the entire suite are pre-existing assertions in an untouched file testing the
PREVIOUS change's migration -- independently confirmed via `git status`, `git log` over the exact
commit range, and an isolated re-run, rather than taken on the apply-progress report's word. The
mandatory audit trail, the attempt-before-send ordering, the close and status write ordering, the
selector-injection allowlist, the verbatim-body guarantee, and the untouched internal human-reply
path are each backed by named, passing, non-trivial tests that were read rather than assumed. Both
reconciliation items in the brief are resolved in the spec files.

The condition is **C1**: `suricata-external-reply/spec.md`'s EXTREPLY-4 still describes reply as a
Playwright driver acquiring `SuricataSession` at high priority. The shipped reply is a plain Botpress
HTTP call and deliberately touches none of that. It is the same class of stale-spec defect as
CLOSE-5, which the brief did authorize fixing -- it simply was not known about. It is a doc edit with
zero code impact, and replacement text is supplied above, already fully test-backed.

**Recommended route**: apply the C1 spec edit, then archive. Do not re-run apply -- no code change is
required by any finding in this report.

**Before any flag is flipped**, which is a separate decision from archiving: C2 makes `rollout.md`'s
per-flag live verification mandatory rather than advisory, because NOTE-7, STATUS-7 and CLOSE-7
(auto-sync selection handling) have no automated coverage and can only be proven against the real
site. Reply remains last, and is irreversible.

No feature flag was flipped by this verification pass.
