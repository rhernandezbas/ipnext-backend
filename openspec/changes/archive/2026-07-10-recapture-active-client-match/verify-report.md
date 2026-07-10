# Verify Report: recapture-active-client-match (BE portion)

**Change**: recapture-active-client-match
**Scope verified**: BE only (worktree `recapture-active-match-be`, branch `feat/recapture-active-match`, HEAD `853de81b`). FE (Phases 6-8) not built yet — worktree `recapture-active-match-fe` does not exist.
**Mode**: Strict TDD (active, per `sdd-init/ipnext-backend` + orchestrator injection)
**Adversarial review**: already run (2 reviewers + fix-wave 853de81b + focused re-review CLEAN) — NOT redone here. This report is SPEC COMPLIANCE only.

---

## Completeness (tasks.md)

| Metric | Value |
|--------|-------|
| BE tasks (1–5.1, 3A, 3B, 4) total boxes | 26 |
| BE tasks complete `[x]` | 25 |
| BE tasks incomplete `[ ]` | 1 (5.1 — orchestrator-run gate; see below) |

- 5.1 (`npm test` full suite green + `npx tsc --noEmit` clean) is checkbox `[ ]` in tasks.md because it is explicitly an "orchestrator runs directly, not a sub-agent task" item — **I re-ran it myself as part of this verify pass and it is GREEN** (see Build & Tests below). Recommend orchestrator check this box.
- 5.2 (push BE) correctly `[ ]` — not done, user-confirmed push required, out of scope for verify.
- Phases 6–9 (FE + review/verify/close) correctly `[ ]` — out of scope for this BE-only verify pass.
- No unchecked BE box represents unfinished work; the single `[ ]` (5.1) is a process/reporting artifact, not a functional gap — confirmed independently below.

---

## Build & Tests Execution (real, re-run in this session)

**TypeScript**: `npx tsc --noEmit` (whole worktree) → **exit 0, clean.**

**Targeted suites (change-relevant, run explicitly)**:
| Suite group | Files | Result |
|---|---|---|
| Application — helper + use cases | `matchActiveClient.test.ts`, `recapture.usecases.test.ts`, `recapture-refine.test.ts` | 3 suites, **89/89 passed** |
| Infrastructure — mappers/parsers/mirror/routes | `PrismaCustomerRepository.mappers.test.ts`, `gestionReal.contractsDelta.parser.test.ts`, `GestionRealClient.test.ts`, `PrismaClientMirrorRepository.upsertData.test.ts`, `InMemoryClientMirrorRepository.upsertContract.test.ts`, `recapture.routes.test.ts` | 6 suites, **93/93 passed** |
| Ripple (fixture-only, GrContract.motivoBaja field addition) | `BackfillGrContractsBatch.test.ts`, `GestionRealSyncScheduler.test.ts`, `InMemoryGestionRealPort.contractsDelta.test.ts`, `SyncGestionRealContractsDelta.test.ts`, `SyncGestionRealContracts.test.ts` | 5 suites, **40/40 passed** |
| Other recapture routes (arity ripple) | `recapture-csv.routes.test.ts`, `recapture-assign.routes.test.ts`, `recapture-refine.routes.test.ts` | 3 suites, **30/30 passed** |

**Full suite** (`npm test`, whole worktree): **720/726 test suites passed (6 skipped, pre-existing/unrelated), 6589/6677 tests passed (88 skipped), 0 failures, exit 0.** Matches the count reported in apply-progress exactly (independently re-run, not trusted blindly).

**Coverage**: not run (no coverage threshold configured in this project's SDD config; skipped per rules — informational only).

---

## Spec Compliance Matrix (24 scenarios)

Legend: PASS = real behavioral test found and passing (would fail on regression). GAP = no pinning test. N/A-FE = frontend-only scenario, not verifiable in this BE worktree.

| # | Scenario (spec.md) | Test | Status |
|---|---|---|---|
| S1a | Lead sin ningún match → `possibleActiveMatchSignals: []` | `recapture.usecases.test.ts` › "returns [] possibleActiveMatchSignals when nothing matches" | ✅ PASS |
| S1b | Página sin leads → 200, `data:[]`, cero matching ops | `recapture.usecases.test.ts` › "does NOT call listActiveContacts() when the page is empty (S1b)" | ✅ PASS |
| S2 | Teléfono — formatos equivalentes (+54/0/9/15/guiones) | `matchActiveClient.test.ts` › "S2: phone signal fires for equivalent formats..." | ✅ PASS |
| S3 | Email — mayúsculas/espacios, match exacto normalizado | `matchActiveClient.test.ts` › "S3: email signal fires after lowercase + trim..." | ✅ PASS |
| S4a | Teléfono corto/basura → no throw, no match | `matchActiveClient.test.ts` › "S4a: short/garbage phone never throws and never signals" | ✅ PASS |
| S4b | Teléfono/email null/vacío en cualquier lado → no throw, resto de señales OK | `matchActiveClient.test.ts` › "S4b: null/empty phone or email..." | ✅ PASS |
| S5 | Exclusión del propio cliente en señales de contacto | `matchActiveClient.test.ts` › "S5: the lead's own clientId is excluded..." | ✅ PASS |
| S6a | Reactivated — propio cliente vuelve a activo | `matchActiveClient.test.ts` › "S6a: reactivated fires when the lead's own client is present..." | ✅ PASS |
| S6b | Reactivated NO dispara con cliente distinto activo | `matchActiveClient.test.ts` › "S6b: a distinct active client matching by phone does NOT trigger reactivated" | ✅ PASS |
| S7a | churn_reason — motivo titularidad, cualquiera de las 2 fuentes | `matchActiveClient.test.ts` › "S7a: churn_reason fires on a case-insensitive 'titularidad' substring..." (+ "S7a (source-agnostic)") + `recapture.usecases.test.ts` › "computes the churn_reason signal from lead.churnReason..." (CSV-source, use-case level) | ✅ PASS |
| S7b | Sin motivo de titularidad en ninguna fuente | `matchActiveClient.test.ts` › "S7b: no churn_reason signal when the texts array is empty..." | ✅ PASS (⚠ see Warning W1 — use-case-level negative case is only an implicit proxy) |
| S16a | churned_client dispara (d) por el contrato, sin churnReason propio | `recapture.usecases.test.ts` › "...Contract.motivoBaja (S16a — no lead.churnReason)" (list, L576) + "...(S16a detail — no lead.churnReason)" (detail, L745) | ✅ PASS |
| S8 | Cardinalidad — múltiples clientes activos matcheados, dedup | `matchActiveClient.test.ts` › "S8: two distinct active clients matching the same lead are both reported, phone signal deduped" + `recapture.usecases.test.ts` › "reports every matched active client, deduplicated by clientId (S8 detail — cardinality)" | ✅ PASS |
| S9a | Detalle sin match → `{signals:[],matchedClients:[]}`, nunca `undefined` | `recapture.usecases.test.ts` › "returns possibleActiveMatch = {signals: [], matchedClients: []} when nothing matches (S9a — never undefined)" | ✅ PASS |
| S9b | churn_reason sin cliente matcheado en detail | `recapture.usecases.test.ts` › "reports churn_reason with matchedClients: [] when there is no client match (S9b)" | ✅ PASS |
| S10 | Cero mutación — llamadas repetidas no cambian nada | `recapture.usecases.test.ts` › "calling execute() repeatedly is read-only — no mutation of the lead or the matched client (S10)" (asserts `stored.updatedAt === lead.updatedAt` after 2 calls) | ✅ PASS |
| S11 | Permisos — 403 sin `recapture.read`; campos presentes en 200 | `recapture.routes.test.ts` › "returns 403 when read perm denied" (pre-existing, still passing) + "includes possibleActiveMatchSignals in each list item (S11)" + "includes possibleActiveMatch {signals, matchedClients} in the detail response (S11)" | ✅ PASS |
| S12 | FE — badge visible/ausente en tabla | `RecaptacionTableView.test.tsx` — does not exist yet (FE worktree not created) | ➖ N/A-FE (defer to FE verify) |
| S13a | FE — drawer con match de contacto | `LeadDetailDrawer.test.tsx` — does not exist yet | ➖ N/A-FE (defer to FE verify) |
| S13b | FE — drawer con churn_reason sin cliente | `LeadDetailDrawer.test.tsx` — does not exist yet | ➖ N/A-FE (defer to FE verify) |
| S14a | Contrato del delta con motivo_baja → persiste | `gestionReal.contractsDelta.parser.test.ts` › "maps motivo_baja → motivoBaja when present (S14a)" + `InMemoryClientMirrorRepository.upsertContract.test.ts` › "create — persists motivoBaja when GR provides it (S14a)" + `PrismaClientMirrorRepository.upsertData.test.ts` › "pins motivoBaja as GR-wins with null passthrough (S14a/S14b)" (source-regex pin, see note N1) | ✅ PASS |
| S14b | Contrato sin motivo_baja → `null`, no rompe | `gestionReal.contractsDelta.parser.test.ts` › "maps motivoBaja to null when motivo_baja is absent" + `InMemoryClientMirrorRepository.upsertContract.test.ts` › "create — motivoBaja is null passthrough when GR omits it (S14b)" | ✅ PASS |
| S15a | Lead nuevo hereda motivo del contrato al ingerir | `recapture.usecases.test.ts` › "a new lead inherits churnReason from the baja contract's motivoBaja (S15a)" | ✅ PASS |
| S15b | Ingest idempotente no re-estampa (forward-only) | `recapture.usecases.test.ts` › "idempotent ingest does NOT re-stamp churnReason on an existing lead (S15b)" | ✅ PASS |

**Compliance summary**: 21/21 BE-verifiable scenarios PASS. 3/3 FE scenarios correctly N/A-for-BE. 24/24 scenarios accounted for, 0 GAP, 0 FAILING.

All pinning tests were **actually executed in this session** (not trusted from the apply-progress report) and are behavioral: each calls the real production function/use-case/route with inputs constructed to exercise the exact branch the scenario describes, and asserts on the resulting value (not a tautology, not an empty-loop, not a smoke-test). Confirmed no `expect(true).toBe(true)`-style assertions, no ghost loops over possibly-empty collections, no ratio of mocks that would flag as mock-heavy.

---

## Migration Check

- File: `prisma/migrations/20260831000000_contract_motivo_baja/migration.sql`
- Content: `ALTER TABLE "Contract" ADD COLUMN "motivoBaja" TEXT;` — **additive only, nullable.** ✅
- Ordering: previous migration is `20260830000000_pppoe_change_audit` — `20260831000000` sorts immediately after it. ✅ Correct, no re-ordering conflict.
- `prisma/schema.prisma`: `Contract.motivoBaja String?` present next to `vendedor`, comment references this change. ✅

---

## tasks.md Spot-Check (5 boxes vs. reality)

| Box | Claim | Verified against code | Match? |
|---|---|---|---|
| 1.1 | RED `matchActiveClient.test.ts` pins S2,S3,S4a,S4b,S5,S6a,S6b,S7a,S7b,S8 | File exists, all 10 scenario IDs found as explicit test labels | ✅ |
| 2.2 | GREEN `PrismaCustomerRepository.listActiveContacts()` = `findMany({where:{status:'active'}})`, exports `toActiveClientContact` | Confirmed at `PrismaCustomerRepository.ts:300-306` — pure Prisma `findMany`, no `$queryRaw` | ✅ |
| 3A.1 | Migration + schema field, timestamp after `20260830000000` | Confirmed above | ✅ |
| 3B.3 | `IngestChurnedClients` +`contractRepo` 3rd ctor param, batch-reads motivoBaja | Confirmed at `IngestChurnedClients.ts:11-16, 36-44` | ✅ |
| 4.1 | `app.ts` L2337-2341 wires `customerAdapter`+`contractRepo` into List/Get/Ingest, zero new singletons | Confirmed at `app.ts:2337-2341`: `new ListRecaptureLeads(recaptureRepo, contractRepo, customerAdapter)`, `new GetRecaptureLead(recaptureRepo, customerAdapter, contractRepo)`, `new IngestChurnedClients(recaptureRepo, customerAdapter, contractRepo)` | ✅ |

All 5 spot-checked boxes match reality exactly.

---

## DIP Compliance (application/domain layer)

9 files changed under `src/application/` + `src/domain/` by this change (per `git diff --stat 2dd8fa3a..853de81b`):
`matchActiveClient.ts`, `ListRecaptureLeads.ts`, `GetRecaptureLead.ts`, `IngestChurnedClients.ts`, `recapture.dto.ts`, `domain/entities/gestionReal.ts`, `domain/ports/ContractRepository.ts`, `domain/ports/CustomerRepository.ts`, `domain/ports/RecaptureRepository.ts`.

Grepped all 9 for `@infrastructure`, `@prisma/client`, `PrismaClient` — **zero matches**. All imports are `@domain/*` and `@application/*` only. DIP holds; no use case reaches into infrastructure/Prisma directly.

---

## Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| Decisión 1 — candidate set in memory, no Prisma OR-query | ✅ Yes | `listActiveContacts()` is a plain `findMany({where:{status:'active'}})`, matching happens in `matchActiveClient` |
| Decisión 2 — phone normalization | ✅ Yes | `normalizePhone`/`suffixMatch` implement the exact rule table (suffix=8, floor=6) |
| Decisión 3 — fail-open | ✅ Yes | Both use cases wrap `listActiveContacts()` AND `findContractTechnologiesByClientIds()` in independent try/catch (post fix-wave), log via `console.warn`, degrade to `[]`/empty shape |
| Decisión 4 — split list/detail richness | ✅ Yes | `possibleActiveMatchSignals: string[]` on list, `possibleActiveMatch: {signals, matchedClients}` on detail, matching the `technologies` precedent |
| Decisión 5 — persist `motivo_baja` (GR-owned, forward-only) | ✅ Yes | Schema + 2 parsers + `upsertContract` data block, `SyncGestionRealContractsDelta.execute()` confirmed untouched |
| Decisión 6 — churn_reason from both sources, piggyback zero-N+1 | ✅ Yes | `motivoBajaByClient` built inside the SAME `findContractTechnologiesByClientIds` loop already used for Tecnología — no extra query |
| Decisión 5b — populate `churnReason` in `IngestChurnedClients` | ✅ Yes | Create-only, never re-stamps (S15b confirms) |
| File Changes table | ✅ Matches | All 14 listed files (BE portion) accounted for in the diff |

No deviations found beyond those already self-reported in apply-progress (Prisma flag name, file path for IngestChurnedClients tests, no dedicated ContractRepository test file, `recapture-refine.test.ts` ripple, missing `listActiveContacts` stub in `recapture.routes.test.ts` before this batch, GetRecaptureLead's fail-open split going slightly beyond Finding 3's literal framing) — all of these were already disclosed and are reasonable, contained interpretations, not silent scope creep.

---

## Issues Found

**CRITICAL** (must fix before archive): None.

**WARNING** (should fix):
- **W1 — S7b weak pin at use-case level.** The pure-helper test (`matchActiveClient.test.ts` "S7b") is a fully explicit, unambiguous pin. At the `ListRecaptureLeads`/`GetRecaptureLead` use-case level, however, there is no test that isolates "lead.churnReason is null AND the client's contract has no motivoBaja-with-titularidad" — it is only implied by the broader "nothing matches at all" test (S1a / S9a). Since `churnReasonTexts` assembly (the actual caller-side logic being verified at this layer) is simple array concatenation with `.filter(Boolean)`, the risk is low, but a dedicated negative-case test at the use-case layer would remove the ambiguity and directly regression-pin the merge logic rather than relying on total absence of any match.
- **W2 — 3 route test files lack the `listActiveContacts`/`findContractTechnologiesByClientIds` stubs.** `recapture-csv.routes.test.ts`, `recapture-assign.routes.test.ts`, `recapture-refine.routes.test.ts` still don't stub these methods in their local `buildApp()` helpers (only `recapture.routes.test.ts` got the stub added in this change, per apply-progress deviation #5). Tests pass because the fail-open path swallows the resulting `TypeError` (visible as `console.warn` noise in test output), but none of these 3 files assert anything about the new fields. Zero functional risk (S11 is fully covered by `recapture.routes.test.ts`), but it's inconsistent test hygiene and produces log noise on every run of those suites.

**SUGGESTION** (nice to have):
- N1: `PrismaClientMirrorRepository.upsertData.test.ts`'s S14a/S14b pin uses a source-regex match against the adapter's own source text (`toMatch(/motivoBaja:\s*k\.motivoBaja\s*\?\?\s*null/)`) rather than a live Prisma call — this is a pre-existing repo convention (`#43`, used identically for `vendedor`), not introduced by this change, and S14a/S14b are independently and behaviorally covered by the `InMemoryClientMirrorRepository` tests in the same batch, so there is no actual compliance gap. Just noting it as an implementation-detail-coupled assertion for awareness.
- Consider adding the missing stubs from W2 to the 3 route test files for consistency, even though no scenario currently depends on it.

---

## Verdict

**PASS_WITH_WARNINGS**

All 24 spec scenarios are accounted for: 21/21 BE-verifiable scenarios pin to a real, currently-passing, behavioral test (verified by actually running the suites in this session, not by trusting checkmarks), 3/3 FE scenarios are correctly deferred as N/A-for-BE. Full test suite (6589/6677 passed, 88 pre-existing skipped) and `tsc --noEmit` are both green. Migration is additive/nullable with correct timestamp ordering. DIP holds across all 9 modified application/domain files. 5/5 spot-checked tasks.md boxes match the code exactly. Zero CRITICAL findings. Two WARNINGs are test-coverage-hygiene issues with no functional risk (weak/implicit pin at one layer that is fully covered at another; missing stubs in unrelated route test files causing log noise, not assertion gaps). Safe to proceed to archive once the orchestrator decides whether W1/W2 warrant a follow-up fix or are accepted debt.

---
---

# Verify Report: recapture-active-client-match (FE portion — appended, BE section above untouched)

**Scope verified**: FE only (worktree `C:\Users\ronald\projects\ipnext\ipnext-frontend\.claude\worktrees\recapture-active-match-fe`, branch `feat/recapture-active-match`, HEAD `05f84998` = `6cc76334` feature + `05f84998` hardening fix-wave). Working tree clean, NOT pushed (correct — 9.3 is orchestrator/user-gated).
**Mode**: Strict TDD (orchestrator-injected, authoritative)
**Adversarial review**: already run on FE (fix wave `05f84998`, re-review CLEAN) — not redone. This section is SPEC COMPLIANCE.

## FE Completeness (tasks.md Phases 6–8)

| Metric | Value |
|--------|-------|
| Phase 6 boxes (6.1–6.3) | 3/3 `[x]` |
| Phase 7 boxes (7.1–7.4) | 4/4 `[x]` |
| Phase 8 (8.1 — orchestrator gate) | `[ ]` — **independently re-run in this verify pass and GREEN** (see below); recommend orchestrator check it |
| Phase 9 (9.1–9.3) | `[ ]` — orchestrator-owned, out of scope here |

No unchecked FE box represents unfinished work; the only `[ ]` boxes (5.1/5.2, 8.1, 9.x) are explicitly orchestrator/user-owned.

## FE Build & Tests Execution (real, re-run in this session)

- **Pinning suites** (`npx vitest run src/__tests__/customers/RecaptacionTableView.test.tsx src/__tests__/customers/LeadDetailDrawer.test.tsx`): **2 files, 66/66 passed** (28 table + 38 drawer), exit 0.
- **TypeScript** (`npx tsc --noEmit`, whole FE worktree): **clean, exit 0, zero output.**
- **Full suite** (`npx vitest run`, whole worktree): **439 test files passed, 4468 tests passed + 1 todo (4469), zero failures, exit 0** (~888s). Matches the apply-progress count exactly (independently re-run). Error stacks in output are stderr noise from expected-throw tests (RouteErrorBoundary/AuthContext) that PASS.
- **Coverage** (scoped to the two pinning files): `RecaptacionTableView.tsx` **95% lines** (uncovered: 230, 294 — pre-existing empty-state/row-click branches). `LeadDetailDrawer.tsx` 59% lines overall, but the uncovered ranges (~114–190 = RegisterContactForm internals, ~410–464 = timeline mapping) are **pre-existing surface untouched by this change**; the new match-section/modal-routing code paths are exercised. Informational only — no threshold configured.

## FE Spec Compliance Matrix (3 scenarios, closing the BE report's N/A-FE rows)

| # | Scenario (spec.md) | Test (file › name) | Status |
|---|---|---|---|
| S12 | FE — Badge visible/ausente en tabla + columnas existentes intactas | `RecaptacionTableView.test.tsx` › M1 (shows with `['phone']`), M2 (absent on `[]`), M3 (absent on `undefined` — old payload), M4 (Wireless tech badge + status pill "Interesado" still render alongside the indicator) | ✅ PASS |
| S13a | FE — Drawer con match de contacto → sección con name/status/matchedBy + acción que abre `ContractHistoryModal` con `matchedClients[i].clientId` | `LeadDetailDrawer.test.tsx` › MS3 (renders "Roberto Diaz" + chips, click opens modal whose subtitle shows the MATCHED name and asserts the lead's own "Ana García" is ABSENT — behaviorally pins clientId=c2, not `view.clientId`) + MS5 (2-client cardinality, second trigger opens modal for "Lucia Fernandez") + MS6 (lead's own "Ver contratos" still routes to the lead's client) | ✅ PASS |
| S13b | FE — Drawer con churn_reason sin cliente → flag visible, sin botón de contratos; sección ausente con signals vacío | `LeadDetailDrawer.test.tsx` › MS4 (churn-only: "Motivo de baja: cambio de titularidad" shown, zero "Ver contratos del match" buttons) + MS2 (section absent when `signals: []`) | ✅ PASS |

**Optional-fields-absent (old payload) no-crash** — required spot-check, pinned three ways: `M3` (table, `possibleActiveMatchSignals` undefined), `MS1` (drawer, `possibleActiveMatch` undefined), `MS8` (drawer, malformed `possibleActiveMatch: {}` — asserts `renderDrawer()` does not throw AND section absent). ✅ PASS.

**Compliance summary (whole change)**: 21/21 BE + 3/3 FE = **24/24 scenarios PASS, 0 GAP, 0 FAILING.**

All FE pinning tests were actually executed in this session and are behavioral, not tautological: each renders the real component with fixtures exercising the exact branch, and asserts on rendered output the user sees (label text, modal subtitle identity, button presence/absence). Negative-path assertions (M2/M3, MS1/MS2) all have companion positive tests with the same setup (M1/M4, MS3–MS5), so none is an orphan empty-check. No `expect(true).toBe(true)`, no ghost loops, no smoke-test-only pins. MS3's strongest assertion is identity-based (matched client's name present AND lead's own name absent inside the scoped dialog) — it fails if clientId routing regresses to `view.clientId`.

## Wire-Contract Consumption Spot-Check (FE vs spec.md Contract)

| Item | FE (`src/types/recaptacion.ts`) | Spec | Match |
|---|---|---|---|
| Signal union | `'phone' \| 'email' \| 'reactivated' \| 'churn_reason'` (L61) | identical 4 values | ✅ |
| `MatchedClientSummary` | `{ clientId: string; name: string; status: CustomerStatus; matchedBy: ('phone'\|'email'\|'reactivated')[] }` (L70-75) — `churn_reason` correctly NOT in `matchedBy` | identical | ✅ |
| List field | `possibleActiveMatchSignals?: ActiveMatchSignal[]` (L165) | same name; FE-optional per design's unified-DTO decision (documented, not drift) | ✅ |
| Detail field | `possibleActiveMatch?: { signals; matchedClients }` (L171-174) | same name/shape | ✅ |
| Signal labels (4) | phone→"Teléfono", email→"Email", reactivated→"Re-alta como cliente", churn_reason→"Motivo de baja: cambio de titularidad" (L63-68), with `?? s` raw fallback at both chip render sites | display-layer (spec silent); complete over the union via `Record<ActiveMatchSignal, string>` | ✅ |
| API passthrough | `recaptacion.api.ts` `listRecaptureLeads`/`getRecaptureLead` return `response.data` untouched — no mapper to drift | 6.3 confirmed zero-change | ✅ |

Token check (6.1): badge uses `StatusBadge status="late"` → `--badge-late-bg/fg` (red); the Wireless tech badge uses `--badge-blocked-bg/fg` (orange) in a different cell — no collision, confirmed in both `.module.css` files.

## FE tasks.md Spot-Check (3 boxes vs reality)

| Box | Claim | Verified against code | Match? |
|---|---|---|---|
| 6.2 | Types + labels, BOTH fields OPTIONAL on unified DTO, guards at read sites | `recaptacion.ts` L61-75/L165-174 exactly as claimed; guards confirmed: table `!signals \|\| signals.length === 0`, drawer `view.possibleActiveMatch &&` + `?? []` + double `?.` in name lookup | ✅ |
| 7.2 | Badge inline in "Contacto" cell (no 8th column), `--badge-late` | `RecaptacionTableView.tsx` L148-153: `PossibleActiveMatchIndicator` inside the existing Contacto column's render; COLUMNS still 7; `StatusBadge status="late"` = `--badge-late` tokens | ✅ |
| 7.4 | `showContracts:boolean` → `contractsClientId: string\|null`, reused by lead's own button; section after "Información" | `LeadDetailDrawer.tsx` L238, L327 (`setContractsClientId(view.clientId)`), L334-340 (section right after the Información `<section>`), L459-466 (modal keyed on `contractsClientId`) | ✅ |

## TDD Compliance (FE batch, per apply-progress evidence table + re-execution)

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | FE table in apply-progress (Phases 6-7 + fix wave) |
| RED confirmed | ✅ | 7.1/7.2: 2 failing before impl (M1, M4); 7.3/7.4: 4 failing (MS3-MS6); fix wave F2/F3/F4 each red-confirmed. MS1/MS2 passed trivially pre-GREEN — honestly disclosed, valid negative-path pins given companions. 6.2 skipped RED (pure types + label Record, zero branching) — reasonable |
| GREEN confirmed (re-run now) | ✅ | 66/66 on both files this session |
| Triangulation | ✅ | 4 badge cases (present/empty/undefined/combined) + 6+3 drawer cases (S13a, S13b, cardinality, own-button, rogue-signal, malformed, reset) |
| Safety net | ✅ | 24/24 (table) + 30/30 (drawer, after mock add changed 0 outcomes) baselines before edits, per apply-progress |

**Test layers**: Unit/RTL only (component tests via testing-library) — this FE project has no E2E infra; consistent with capabilities. **Assertion quality**: no CRITICAL, no WARNING findings.

## FE Coherence (design.md §FE Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| Badge inline in Contacto cell, NOT an 8th column | ✅ | Confirmed in COLUMNS def |
| Render only when `signals.length > 0` (absence = no dash) | ✅ | `PossibleActiveMatchIndicator` returns `null` |
| Token `--badge-late` (red), avoid `--badge-blocked` collision | ✅ | Verified both CSS files |
| Drawer `<section>` after "Información", `view.*` pattern | ✅ | L334-340, reads from `view` |
| Reuse `ContractHistoryModal` with `matchedClients[i].clientId`, zero new fetch code | ✅ | Single shared `contractsClientId` state; `ContractHistoryModal.tsx` untouched by the diff |
| churn_reason-sin-cliente → section visible without contracts button | ✅ | MS4 pins it |
| Optional fields + `?? []`/`?.` guards | ✅ | All read sites guarded (M3/MS1/MS8 pin) |
| No new TanStack invalidations | ✅ | Diff touches no hooks/query keys |

Disclosed deviations (apply-progress) re-checked and accepted: local `matchedClientBadgeStatus` instead of exporting ContractHistoryModal's private mapper (scope containment); modal now mounts only when `contractsClientId` set (strict improvement, was always-mounted-closed); `useCustomers` mock added file-wide (zero regression, 30/30 stayed green). None is silent scope creep.

## FE Issues Found

**CRITICAL**: None.

**WARNING**:
- **W-FE1 — `LeadDetailDrawer.tsx` scoped line coverage is 59%.** The uncovered ranges are pre-existing, untouched surface (RegisterContactForm internals, contact timeline), not the new match-section code — but per strict-TDD changed-file policy (<80%) it must be flagged. Zero functional risk for this change; closing it would mean testing code this change didn't write. Accept or defer to a hygiene follow-up.

**SUGGESTION**:
- N-FE1: `PossibleActiveMatchSectionProps.match` is typed `{ signals: string[]; ... }` (loose) rather than `ActiveMatchSignal[]` — deliberate for rogue-value tolerance (MS7), but a one-line comment tying it to MS7 would prevent a future "tighten the type" refactor from silently breaking the fallback path.
- N-FE2: MS3's `getAllByText('Teléfono')).toHaveLength(2)` couples to the lead-level chip + matchedBy chip both rendering; if a dedup is ever introduced by design, update the count with intent (the assertion is correct today).

## FE Verdict

**PASS**

3/3 FE scenarios (S12, S13a, S13b) pin to real, behavioral, currently-passing Vitest tests (executed in this session: 66/66 pinning + 4468/4468 full suite + `tsc --noEmit` clean). The old-payload/malformed-payload no-crash requirement is triple-pinned (M3/MS1/MS8). Wire contract consumed field-for-field per spec, all 4 signal labels complete with raw fallback. 3/3 spot-checked tasks.md boxes match the code; the only unchecked boxes are orchestrator-owned gates. One WARNING (pre-existing coverage debt in the drawer file, not introduced here), zero CRITICAL.

**Whole-change verdict (BE + FE)**: **PASS_WITH_WARNINGS** — 24/24 scenarios compliant; open warnings are BE W1/W2 (test hygiene) + FE W-FE1 (pre-existing coverage), all non-blocking. Ready for 9.3 (push BE with migration, then FE) at the orchestrator/user's discretion.
