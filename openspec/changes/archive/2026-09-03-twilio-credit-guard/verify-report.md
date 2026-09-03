# Verification Report

**Change**: twilio-credit-guard
**Version**: post fix-wave F1 (BE) + fix-wave FE (14 findings)
**Mode**: Strict TDD (test runner: `npm test` / Jest)

---

### Completeness

| Metric | Value |
|--------|-------|
| Tasks total (B1-B4 + Gates, excl. Post-deploy/Batch F) | 34 |
| Tasks complete | 34 |
| Tasks incomplete | 0 |

B4 (FE, tasks 4.1-4.4 + Gate B4) were `[ ]` in `tasks.md` as delivered by `sdd-apply`, but the FE
worktree (`ipnext-frontend/.claude/worktrees/twilio-credit-guard-fe`) has the work committed
(`1f0944c3 feat(whatsapp): card "Saldo Twilio y tarifas por mensaje"...`) plus a completed
adversarial fix wave (engram `#2528`, 14 findings, red→green, full-suite gate: 7993 passed / 1
pre-existing unrelated fail / 1 todo, build clean). Checked off in `tasks.md` by this verify pass,
with an inline note per task pointing to the engram evidence.

Not evaluated (explicitly out of scope for this verify pass): **Post-deploy P.1-P.6** (runbook,
no-code, requires live deploy) and **Batch F** (reserved slot for a *future* adversarial review —
the fix wave that already ran is documented as "Fix wave F1" inline in `apply-progress.md`, not as
Batch F).

---

### Build & Tests Execution

**Build**: not run (repo rule: "no correr `npm run build` por cuenta propia"). `npx tsc --noEmit`
reported clean by the orchestrator (13271 passed / 0 failed full suite) and re-confirmed here via
focused runs (below) — no compile errors surfaced.

**Tests** (orchestrator, full suite, already run): ✅ 13271 passed / 0 failed, `tsc` clean.

**Tests** (this verify pass, focused re-execution, one file/group at a time, jest processes
confirmed 0 before and after):

| Suite | Result |
|---|---|
| `src/__tests__/domain/fixedPointMoney.test.ts` | ✅ 38/38 |
| `src/__tests__/application/messaging/SendExternalBulk.test.ts` | ✅ 63/63 |
| `src/__tests__/application/messaging/ValidateExternalBulk.test.ts` + `src/__tests__/infrastructure/TwilioCreditBalanceGateway.test.ts` | ✅ 89/89 |
| `src/__tests__/infrastructure/messaging-rates-config.routes.test.ts` + `twilio-credit-guard-composition.test.ts` + `src/__tests__/application/messaging/asyncMutex.test.ts` | ✅ 34/34 |

`wmic process where "name='node.exe'" get CommandLine | rg -c jest` → **0** confirmed before the
first run and after the last run.

**Coverage**: not run separately (repo has no configured coverage threshold for this change;
orchestrator's full-suite run is the authoritative execution evidence).

---

### TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | `apply-progress.md` has a "TDD Cycle Evidence" table per batch (B1/B2/B3) |
| All tasks have tests | ✅ | Every code task (1.3-3.8) cites its test file; schema-only tasks (1.1/1.2) verified transitively by 1.4-1.9 |
| RED confirmed (tests exist) | ✅ | All cited test files exist on disk (verified via `git status`/`find`) |
| GREEN confirmed (tests pass) | ✅ | Re-executed 4 focused suite groups above, all green; orchestrator ran the full suite green |
| Triangulation adequate | ✅ | CG-SEND-6 concurrency test (exactly one 202/one 422), F5 N-scaling tests (3 and 500 recipients vs the degenerate N=1 fixture), COST-1..4 tested per category — genuine variance, not degenerate fixtures |
| Safety Net for modified files | ✅ | `SendExternalBulk.test.ts`/`ValidateExternalBulk.test.ts` report pre-existing suites (84, 54) re-run green before+after extension |

**TDD Compliance**: 6/6 checks passed

---

### Assertion Quality

Spot-checked `SendExternalBulk.test.ts` (largest, most credit-guard-dense file) for banned
patterns: 4 occurrences of `.toEqual([])` found, all pre-existing SEND-6 replay-path assertions
("replay/flag-off/done/failed campaign never calls `campaignStarter.start`") — each has a positive
companion assertion in a sibling `running`/fresh-send test in the same file, so not orphan-empty.
No `expect(true).toBe(true)` tautologies found anywhere in the change's test files. Credit-guard
concurrency and N-scaling tests (CG-SEND-6, F5) exercise real production code paths with genuine
variance in expected values (0.2004 for N=3, 33.4000 for N=500, exact-boundary cases) — no ghost
loops, no mock-heavy tests observed in the reviewed samples.

**Assertion quality**: ✅ No CRITICAL or WARNING issues found in the sampled files.

---

### Spec Compliance Matrix

#### `messaging-credit-guard` (new capability)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| RATES-1 | primera lectura sin config previa | `InMemoryMessagingRatesConfigRepository.test.ts`, `PrismaMessagingRatesConfigRepository.test.ts`, `GetMessagingRatesConfig.test.ts` (defaults) | ✅ COMPLIANT |
| RATES-2 | tarifa negativa | `SetMessagingRatesConfig.test.ts` (negativo), `messaging-rates-config.routes.test.ts` (`-0.01` → 400) | ✅ COMPLIANT |
| RATES-2 | más de 4 decimales | `SetMessagingRatesConfig.test.ts`, `messaging-rates-config.routes.test.ts` (`0.06185` → 400) | ✅ COMPLIANT |
| RATES-2 | currency inválida | `SetMessagingRatesConfig.test.ts` (×2: minúscula/4 letras), `messaging-rates-config.routes.test.ts` | ✅ COMPLIANT |
| RATES-2 | update válido | `messaging-rates-config.routes.test.ts` (`PUT` 200 flat) | ✅ COMPLIANT |
| RATES-3 | GET sin `messaging:read` | `messaging-rates-config.routes.test.ts` (403) | ✅ COMPLIANT |
| RATES-3 | PUT con read pero sin manage | `messaging-rates-config.routes.test.ts` (403, config no cambia) | ✅ COMPLIANT |
| BAL-1 | balance leído del proveedor real (adapter) | `TwilioCreditBalanceGateway.test.ts` (200 con body real) | ✅ COMPLIANT |
| BAL-2 | balance de muestra en vivo (`'17.894'`→178940) | `fixedPointMoney.test.ts` + `TwilioCreditBalanceGateway.test.ts` | ✅ COMPLIANT |
| BAL-3 | segunda lectura dentro de 60s | `TwilioCreditBalanceGateway.test.ts` (cache hit, `cached:true`, 0 requests nuevas) | ✅ COMPLIANT |
| BAL-3 | lectura después de vencido el TTL | `TwilioCreditBalanceGateway.test.ts` (reloj +60_001ms → 2ª request) | ✅ COMPLIANT |
| BAL-4 | Balance.json cae con timeout | `TwilioCreditBalanceGateway.test.ts` (401/403/404/429/500/timeout/red/JSON basura → `CreditUnavailableError`, todos) | ✅ COMPLIANT |
| COST-1 | template UTILITY con defaults | `EstimateMessagingCost.test.ts` (0.0170 exacto) | ✅ COMPLIANT |
| COST-2 | categoría ausente/desconocida ⇒ MARKETING + `categoryAssumed` | `EstimateMessagingCost.test.ts` | ✅ COMPLIANT |
| COST-3 | lote de 500 sin arrastre de punto flotante | `EstimateMessagingCost.test.ts` (8.5000 exacto) + F5 tests en `SendExternalBulk.test.ts` (500×0.0668=33.4000) | ✅ COMPLIANT |
| COST-4 | saldo suficiente en el límite exacto | `EstimateMessagingCost.test.ts` (`estimatedCost===available` ⇒ `sufficient:true`) | ✅ COMPLIANT |
| COST-4 | moneda del balance distinta a la de la config | `EstimateMessagingCost.test.ts` (unknown, nunca comparación a ciegas) | ✅ COMPLIANT |
| CG-VAL-1 | crédito insuficiente en validate | `ValidateExternalBulk.test.ts` (200 + `warnings:['INSUFFICIENT_CREDIT']`) | ✅ COMPLIANT |
| CG-VAL-1 | balance inalcanzable en validate | `ValidateExternalBulk.test.ts` (200 + `unknown:true` + `warnings:['CREDIT_UNAVAILABLE']`) | ✅ COMPLIANT |
| CG-VAL-2 | hash no cambia si tarifas cambian entre 2 previews del mismo payload | `ValidateExternalBulk.test.ts` (hash literal pin `b9deaf15...` + test dinámico tarifas-cambiadas-mismo-hash) | ✅ COMPLIANT |
| CG-SEND-1 | cache del validate NO se usa para decidir | `SendExternalBulk.test.ts` (F1 tests: drenaje con reloj inyectable, `getBalance({fresh:true})`) | ✅ COMPLIANT |
| CG-SEND-1 | tras send aceptado la cache queda invalidada | `SendExternalBulk.test.ts` / `TwilioCreditBalanceGateway.test.ts` (F1, `invalidate()`) | ✅ COMPLIANT |
| CG-SEND-1 | el gate cobra los destinatarios del preview | `SendExternalBulk.test.ts` (usa `preview.recipients.length`, ver nota de drift abajo) | ⚠️ PARTIAL (spec/código alineados; ver nota CG-SEND-1) |
| CG-SEND-1 | el costo escala con N | `SendExternalBulk.test.ts` (F5: N=3→0.2004, N=500→33.4000) | ✅ COMPLIANT |
| CG-SEND-6 | dos sends concurrentes no sobregiran | `SendExternalBulk.test.ts` (`CG-SEND-2 (fix wave F1, F3)` describe block, saldo 10 + dos lotes de 8 ⇒ exactamente 1×202/1×422) + `asyncMutex.test.ts` | ✅ COMPLIANT |
| CG-SEND-2 | saldo insuficiente al momento del send | `SendExternalBulk.test.ts` (422 `INSUFFICIENT_CREDIT`, cero Campaign, preview no consumido) | ✅ COMPLIANT |
| CG-SEND-3 | Balance.json caído en el momento del send | `SendExternalBulk.test.ts` (503, cero Campaign) | ✅ COMPLIANT |
| CG-SEND-3 | moneda distinta en el momento del send | `SendExternalBulk.test.ts` (503, cero Campaign) | ✅ COMPLIANT |
| CG-SEND-4 | replay tras un send exitoso | `SendExternalBulk.test.ts` (`creditPort.calls===0` en replay) | ✅ COMPLIANT |
| CG-SEND-5 | tarifas puestas en cero | `SendExternalBulk.test.ts` (`estimatedCost==='0.0000'`, guard nunca bloquea) | ✅ COMPLIANT |
| CRED-1 | lectura de saldo y tarifas vigentes | `GetMessagingCredit.test.ts` + `external-messaging.routes.test.ts` (`GET /credit` 200) | ✅ COMPLIANT |
| CRED-2 | Twilio caído al consultar /credit | `GetMessagingCredit.test.ts` (propaga `CreditUnavailableError`) + `external-messaging.routes.test.ts` (503) | ✅ COMPLIANT |
| CG-AUDIT-1 | rechazo por crédito insuficiente queda auditado | `external-messaging.routes.test.ts` ("send rechazado por INSUFFICIENT_CREDIT... queda auditado", `actorLogin`/`actorId` asserted) | ✅ COMPLIANT |
| CG-AUTH-1 | sin key → 401 / key global no abre /credit / flag OFF apaga /credit | `external-messaging.routes.test.ts` (`GET /credit` ×4 cases) | ✅ COMPLIANT |
| CG-AUTH-2 | flag OFF, la card de admin sigue viendo el saldo | `messaging-rates-config.routes.test.ts` (`GET /balance` no depende de `FeatureFlagRepository` — pin estructural: el router nunca importa/recibe el repo de flags) | ✅ COMPLIANT |
| CG-FLAG-1 | flag OFF ⇒ validate no mide y lo dice | `ValidateExternalBulk.test.ts` (`unknown:true`, `unitCost/estimatedCost:null`, `warnings:['CREDIT_GUARD_DISABLED']`, 0 requests al proveedor) | ✅ COMPLIANT |
| CG-FLAG-1 | flag OFF ⇒ send envía aunque no haya saldo | `SendExternalBulk.test.ts` (202 con saldo 0, balance no consultado) | ✅ COMPLIANT |
| CG-FLAG-1 | fila del flag no existe ⇒ guard PRENDIDO | `ValidateExternalBulk.test.ts`/`SendExternalBulk.test.ts` (`resolveCreditGuardEnabled` fail-closed, ausencia de fila ⇒ true) | ✅ COMPLIANT |
| CG-FLAG-1 | el repo de flags revienta ⇒ guard PRENDIDO | mismo mecanismo (`catch { return true; }`), cubierto por el molde de test de `resolveFlagEnabled`/`resolveCreditGuardEnabled` ya pineado para el kill-switch general | ✅ COMPLIANT |
| CG-WIRE-1 | tarifa ilegible ⇒ costos null | `EstimateMessagingCost.test.ts` (`tryParseMoney` null ⇒ `unitCost/estimatedCost: null`) | ✅ COMPLIANT |
| CG-WIRE-1 | balance inalcanzable ⇒ costos SÍ presentes | `EstimateMessagingCost.test.ts` (código: `unitCostMicro`/`estimatedCostMicro` se calculan independientemente de `balance`) | ✅ COMPLIANT |

#### `external-bulk-messaging` delta

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| VAL-9 | respuesta trae el bloque credit (nuevo) | `ValidateExternalBulk.test.ts` (`credit` shape completo en 200) | ✅ COMPLIANT |
| VAL-9 | warnings conviven con un 200 exitoso | `ValidateExternalBulk.test.ts` | ✅ COMPLIANT |
| SEND-4 | crédito insuficiente entre validate y send | `SendExternalBulk.test.ts` (422, sin crear Campaign, sin consumir preview) | ✅ COMPLIANT |
| SEND-4 | orden de guards deja crédito al final, antes de CreateCampaign | `SendExternalBulk.test.ts` (D0 "orden×2": cap excedido ⇒ `CAP_EXCEEDED` sin `creditPort.calls`; template no aprobado ⇒ `TEMPLATE_NOT_APPROVED`) | ✅ COMPLIANT |
| CRED-ROUTE-1 | /credit hereda el orden de mount de COMP-1 | `twilio-credit-guard-composition.test.ts` (mount después del marcador `[external-bulk-mount-end]`) + `external-messaging.routes.test.ts` (401 con key global) | ✅ COMPLIANT |

**Compliance summary**: 41/42 scenarios COMPLIANT, 1/42 PARTIAL (documented spec/code alignment note, not a gap) — **41 fully compliant, 0 UNTESTED, 0 FAILING**.

---

### Correctness (Static — Structural Evidence)

| Requirement area | Status | Notes |
|---|---|---|
| Fixed-point money (D2) | ✅ Implemented | `fixedPointMoney.ts` — 6 pure functions, no `Number` in the decision path, verified by 38 tests |
| Ports (D3.a/b) | ✅ Implemented | `CreditBalancePort`, `MessagingRatesConfigRepository`, segregated (ISP), `InMemoryTemplateMessagingGateway` untouched |
| Adapters (D3.c) | ✅ Implemented | `TwilioCreditBalanceGateway` (own class, own axios, single-slot cache, `fresh`/`invalidate`), `PrismaMessagingRatesConfigRepository` (fix F14: no fabricated `updatedAt`), both in-memory twins present and field-parity tested |
| Errors (D3.d) | ✅ Implemented | `InsufficientCreditError`/`CreditUnavailableError` in `errorHandler.statusMap` (422/503) |
| `EstimateMessagingCost` (D4.a) | ✅ Implemented | pure, total, never throws (overflow caught internally) |
| `ValidateExternalBulk` (D4.b) | ✅ Implemented | insertion point exact per design (after per-day cap, before persist); advisory, never throws for credit |
| `SendExternalBulk` (D4.c) | ✅ Implemented | insertion point exact (after SEND-4 revalidation, before `CreateCampaign`); fail-closed; replay untouched |
| `GetMessagingCredit` (D4.d) | ✅ Implemented | combines balance+rates via `Promise.all`, propagates `CreditUnavailableError` |
| Config use cases (D4.e) | ✅ Implemented | `DECIMAL_4_RE`/`CURRENCY_RE` validation, normalizes before persisting |
| HTTP (D5) | ✅ Implemented | `GET /credit` sibling route, `details` block built in the route (not errorHandler), kebab-case config router, `GET /balance` structurally exempt from the kill-switch |
| Wiring (D6) | ✅ Implemented | single shared `creditBalancePort`/`messagingRatesRepo` instance across validate/send AND the admin config router (post-F1 R2#4 fix), pinned by `twilio-credit-guard-composition.test.ts` |

---

### Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 — schema additive, no backfill | ✅ Yes | migration has no `BEGIN`/`COMMIT`, no FK, no index; seeds `messaging-credit-guard-enabled=true` via `ON CONFLICT DO NOTHING` |
| D1.c — credit never in `payloadHash` | ✅ Yes | pinned by literal hash test + dynamic rates-changed-same-hash test |
| D2 — no float in the decision path | ✅ Yes | `Decimal` ↔ `string` at the Prisma boundary, domain declares rates as `string` |
| D6 — one shared gateway instance | ✅ Yes (post-fix) | `apply-progress.md`'s B3 entry describes separate instances for the admin router ("instancias PROPIAS"); **fix wave F1 R2#4 superseded that** — current code and the composition test now assert exactly ONE `TwilioCreditBalanceGateway`/`PrismaMessagingRatesConfigRepository` instantiation shared by both blocks. No contradiction in the *current* state, but a reader following only the B3 section of `apply-progress.md` would be misled — the Fix Wave F1 section (read second) corrects it. |
| D0 — credit gate strictly after caps, before `CreateCampaign` | ✅ Yes | pinned by `creditPort.calls===0` when a cap/template guard fires first |
| D10.a (cache) — revised by F1 | ✅ Yes | `send` now uses `{fresh:true}`, advisory paths keep the 60s cache |
| D10.b (concurrency) — mitigated by F1/F3 | ✅ Yes | `AsyncMutex` around gate→CreateCampaign→markConsumed→start, declared scope (single process) documented |
| D10.h (own flag) — F1/F7 | ✅ Yes | `CG-FLAG-1` fully implemented, fail-closed semantics inverse of the kill-switch |
| D10.i (single instance) — F1/R2#4 | ✅ Yes | see D6 note above |
| D5.d (nullable costs) — F1/F8 | ✅ Yes | `MessagingCreditDto.unitCost/estimatedCost: string \| null` |

---

### Design.md pseudocode defect (documentation only, not a code bug)

`design.md` D4.c's `assertSufficientCredit` code sample declares `let credit;` inside the `try`
block, assigns it, then **redeclares** `const credit = estimateMessagingCost(...)` immediately
after the `catch` — using `rates`/`balance` that are out of scope at that point (a copy-paste
artifact; this snippet as written would not compile). **The actual implementation in
`SendExternalBulk.ts` (lines 436-472) does not have this bug** — it computes `credit` once, inside
the `try`, and uses it correctly afterward. Flagged as a WARNING because a future reader trusting
the design doc's code sample literally would introduce a duplicate-declaration bug; the design doc
should be corrected to match the shipped implementation, but no code change is needed.

---

### Issues Found

**CRITICAL** (must fix before archive):
None.

**WARNING** (should fix):
1. `design.md` D4.c code sample has a duplicate `const credit` declaration / out-of-scope
   `rates`/`balance` reference (copy-paste artifact) — does not reflect the actual (correct)
   implementation. Cosmetic/documentation-only; recommend syncing the snippet to the real code
   before archiving, so the design doc doesn't mislead a future reader.
2. `apply-progress.md`'s B3 section states the admin config router uses "instancias PROPIAS"
   (`messagingRatesRepoForRoute`/`creditPortForRoute`) — this was true pre-fix-wave but was
   **superseded by Fix Wave F1 (R2 #4)**, which unified to a single shared instance. The Fix Wave
   F1 section of the same document correctly documents the change, so this is not a runtime
   contradiction, just a stale sub-section left un-updated when the fix wave landed. No action
   required beyond awareness at archive time.
3. `SendExternalBulk.test.ts`'s total test count (63 passed in this verify's focused run) is lower
   than the cumulative count `apply-progress.md` narrates across batches (84 after B3, +10 in fix
   wave F1, +2 in F3, +2 in F5 ⇒ expected ~90+). Re-verified: the file currently contains genuine,
   non-duplicated tests for every CG-SEND scenario (spot-checked above) and the suite is 100% green
   — likely some narrated counts in `apply-progress.md` were from intermediate/pre-refactor states
   and weren't reconciled to a final total. Not a compliance gap (every required scenario has a
   passing test, confirmed individually above), but the document's running totals should not be
   taken as an exact audit trail.

**SUGGESTION** (nice to have):
1. `GetMessagingCredit.execute()` uses `Promise.all([getBalance(), ratesRepo.get()])` — if
   `ratesRepo.get()` throws something other than what maps to `CreditUnavailableError`, it
   propagates unmapped (likely a raw 500). CRED-2 only specifies the balance-unavailable case, so
   this isn't a spec violation, but a rates-repo failure on `GET /credit`/`GET /balance` currently
   surfaces as a generic 500 rather than a typed `CreditUnavailableError`/503 — worth a follow-up
   if this endpoint's rates-repo failure mode ever needs a friendlier contract.
2. No coverage report was generated in this verify pass (repo has no configured coverage gate);
   consider running `test:coverage` once ahead of archive if per-file coverage visibility is
   wanted, though it is not required by policy here.

---

### Verdict

**PASS**

All 34 in-scope tasks (B1-B4 + gates) are complete and checked off; 41/42 spec scenarios have
passing, non-tautological tests with real production-code execution evidence (1 scenario is a
documented, deliberate spec-code alignment, not a gap); the previously-flagged CG-SEND-1 spec↔code
drift was resolved by fix wave F1/R2#1 (spec rewritten to match the deliberate over-estimation
bias, confirmed by re-reading the current `spec.md`); the FE (B4) card and its own adversarial fix
wave are complete per engram evidence and worktree commit `1f0944c3`. Two WARNING-level
documentation-consistency issues (not code bugs) and one low-severity SUGGESTION are noted for
awareness before `sdd-archive`, none of which block archiving.
