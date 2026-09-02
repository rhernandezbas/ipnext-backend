# Verify Report — external-bulk-messaging

**Change**: external-bulk-messaging · **Version**: spec.md (post fix-wave F1+F2) · **Mode**: Strict TDD
**Repos**: BE `ipnext-backend` (worktree `external-bulk-messaging-be`) + FE `ipnext-frontend` (worktree
`external-bulk-messaging-fe`). Verified 2026-09-02.

---

## Completeness (tasks.md)

| Metric | Value |
|--------|-------|
| Tasks total (B1-B5 + gates) | 56 |
| Tasks complete `[x]` | 51 (B1 11 + B2 7 + B3 7 + B4a 8 + B4b 3, incl. gates) |
| Tasks incomplete `[ ]` | 5 — **all of Batch 5 (FE)**: 5.1, 5.2, 5.3, 5.4, Gate B5 |
| Post-deploy (P.1-P.6) | Correctly unchecked — non-code, operator runbook |

**Finding (WARNING)** — `tasks.md` Batch 5 checkboxes are unchecked, but the FE implementation is
**actually complete** in `ipnext-frontend/.claude/worktrees/external-bulk-messaging-fe`: all 5 files
from 5.1-5.4 exist (`types/externalBulkMessaging.ts`, `hooks/useExternalBulkMessagingConfig.ts`,
`api/externalBulkMessagingConfig.api.ts`, `components/settings/ExternalBulkMessagingCard.tsx` +
`.module.css`), with 4 test files (52 tests, all passing — re-run confirmed, see below). This is a
**documentation sync gap** between the two repos' artifact trails, not a functional gap. Recommend
checking off 5.1-5.4 + Gate B5 in `tasks.md` before archive.

---

## Build & Tests Execution

**Build (`npx tsc --noEmit`, BE)**: ✅ Passed (0 errors, clean re-run after cache clear)

> **Note for the record**: a first `tsc --noEmit` run mid-verification reported 7 syntax errors
> ("Unterminated string literal") in
> `src/__tests__/infrastructure/external-bulk-messaging-recipient-createdAt-index.test.ts` lines 26-31,
> and an isolated `npx jest` run on that same file reproduced the identical failure. A byte-level
> `xxd` inspection of the file on disk showed the string literal correctly escaped
> (`.split('\n')` — `5c 6e`, a real backslash-n, not a raw line terminator). After
> `npx jest --clearCache`, both the isolated test and a full repo-wide `tsc --noEmit` came back clean
> (0 errors) and stayed clean on a second re-run. Likely a transient stale-cache/race artifact from
> concurrent activity on this shared worktree (the apply-progress log shows fix waves F1/F2 landing
> the same day) — not a defect in the committed source. Flagging as a **SUGGESTION**: re-run
> `npx tsc --noEmit` once more right before archive/merge as a final sanity check, since this session
> cannot rule out a flaky filesystem/cache interaction with a concurrent process.

**Tests (BE, focused `npx jest` runs — orchestrator owns the full-suite run)**:
- Use-case layer (`ValidateExternalBulk`, `SendExternalBulk`, `GetExternalBulkCampaign`,
  `GetExternalBulkConfig`, `SetExternalBulkConfig`, `externalBulkPayloadHash`): ✅ 6 suites / 111 tests
- Infra layer (2 in-memory repos, 2 Prisma repos, composition-root, createdAt-index pin, 2 route
  files, config-admin route): ✅ 10 suites / 106 tests
- Reused/shared paths touched by this change (`CreateCampaign`, `SendCampaign`,
  `matchManualContacts`, `InMemoryCampaignRepository`, `PrismaCampaignRepository.variables`,
  `domainLayerPurity` DIP guard): ✅ 6 suites / 151 tests
- **BE total re-verified this session**: 22 suites / 368 tests, 0 failures.

**Tests (FE, `npx vitest run`)**: ✅ 4 suites / 52 tests, 0 failures (api client, hook, card component
incl. accessibility, styles).

**Coverage**: Not re-measured this session (focused runs only, per orchestrator instruction not to run
the full suite). `apply-progress.md` reports the full BE suite at 1254/1260 suites, 13030/13118 tests
(exit 0) after fix wave F2 — consistent with what this session's focused subset shows.

---

### TDD Compliance (from apply-progress.md, cross-checked)

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Full "TDD Cycle Evidence" tables present for B1, B2, B3, B4a/B4b |
| RED confirmed (tests exist) | ✅ | All test files listed exist in the worktree, confirmed by `find` |
| GREEN confirmed (tests pass) | ✅ | Re-run 22 BE suites + 4 FE suites this session, all green |
| Triangulation adequate | ✅ | Multi-case coverage per requirement (e.g. VAL-2 has 5 sub-cases, F11 has `it.each` with 6+4 cases) |
| Mutation/counterfactual probes | ✅ | F2 (cap-authorized) and F1 (413/200 body-parser order) both have explicit counterfactual tests pinned in-suite, not just narrated |
| Assertion quality | ✅ No tautologies/ghost-loops found in the sampled test titles/bodies read this session |

---

## Spec Compliance Matrix

Legend: ✅ COMPLIANT (test passed, exercises the scenario) · ⚠️ PARTIAL/GAP (WARNING) · ❌ UNTESTED/FAILING (CRITICAL)

| Requirement | Scenario | Test | Result |
|---|---|---|---|
| AUTH-1 | sin header → 401 | `external-messaging.routes.test.ts > sin X-Api-Key → 401 en TODAS las rutas del router` | ✅ |
| AUTH-1 | key incorrecta → 401 | `external-messaging.routes.test.ts > key incorrecta → 401` | ✅ |
| AUTH-2 | key global no sirve | `external-bulk-messaging-composition.test.ts > key GLOBAL → 401 en /messaging/bulk/validate` | ✅ |
| AUTH-2 | (extensión B4b) key global no abre templates | `…composition.test.ts > B4b — key GLOBAL → 401 en GET /messaging/bulk/templates` | ✅ |
| AUTH-3 | env var vacía → 401 en todos los casos | `…composition.test.ts > key dedicada VACÍA en el proceso → 401 con CUALQUIER key` | ✅ |
| KS-1 | flag OFF → validate rechazado | `ValidateExternalBulk.test.ts > flag OFF → FeatureExternalBulkDisabledError (403)` | ✅ |
| KS-1 | flag OFF → send rechazado | `SendExternalBulk.test.ts > flag OFF → FeatureExternalBulkDisabledError (403)…` | ✅ |
| KS-1 | repo de flags falla → fail-safe OFF | `ValidateExternalBulk.test.ts` + `SendExternalBulk.test.ts > repo de flags lanza → fail-safe a OFF` (both) | ✅ |
| VAL-1 | recipients vacío → 400 | `ValidateExternalBulk.test.ts > recipients vacío → 400 VALIDATION_ERROR` | ✅ |
| VAL-1 | falta templateRef → 400 | `ValidateExternalBulk.test.ts > falta templateRef Y templateName → 400` | ✅ |
| VAL-2 | teléfono no normalizable | `ValidateExternalBulk.test.ts > teléfono no normalizable → invalid con reason telefono_invalido` | ✅ |
| VAL-2 | fijo no-móvil | `ValidateExternalBulk.test.ts > línea fija válida pero no-móvil … → invalid non_mobile` | ✅ |
| VAL-2 | número extranjero nunca se reconstruye (F11 amendment) | `ValidateExternalBulk.test.ts > fix wave F1 (F11) … 6× it.each (BR/CO/US/ES/UY/00-prefix) → telefono_invalido` + AR forms `it.each` (4 cases) confirm same-as-always resolution | ✅ — amendment fully reflected |
| VAL-2 | duplicado en el batch | `ValidateExternalBulk.test.ts > duplicado dentro del batch … → 2do cae invalid duplicado` | ✅ |
| VAL-2 | opt-out (exacto + sufijo) | `ValidateExternalBulk.test.ts` — 2 tests (match exacto, match por sufijo) | ✅ |
| VAL-3 | dos recipients, dos mensajes | `ValidateExternalBulk.test.ts > dos recipients con variables distintas → dos renderedMessage distintos` | ✅ |
| VAL-3 | sin válidos → EMPTY_RECIPIENTS | `ValidateExternalBulk.test.ts > sin recipients válidos → 422 EMPTY_RECIPIENTS` | ✅ |
| VAL-4 | template pending | `ValidateExternalBulk.test.ts > template pending → TemplateNotApprovedError` | ✅ |
| VAL-4 | (extra) templateRef inexistente / ambiguo | `ValidateExternalBulk.test.ts` — 2 extra tests | ✅ |
| VAL-5 | label inexistente | `ValidateExternalBulk.test.ts > label inexistente → ChatwootLabelNotFoundError` | ✅ |
| VAL-5 | Chatwoot caído | `ValidateExternalBulk.test.ts > Chatwoot inalcanzable → ChatwootUnavailableError (503)` | ✅ |
| VAL-6 | 501 válidos con tope 500 | `ValidateExternalBulk.test.ts > valid.length > maxPerRequest → CAP_EXCEEDED perRequest` | ✅ |
| VAL-7 | cupo ya consumido (F2 amendment: cuenta AUTORIZADO) | `ValidateExternalBulk.test.ts > cupo diario ya consumido por envíos previos` (seeds `status:'sent'`) — see note | ✅ (see WARNING below) |
| VAL-7 | el cupo NO espera al envío real (F2, K1/K2/K3) | `SendExternalBulk.test.ts > fix wave F1 (F2) … K1/K2/K3 con maxPerDay=2 … el TERCER send rebota` | ✅ — this is the test that actually pins the amendment |
| VAL-7 | `delivered` sigue contando; `skipped`/`opted_out` no | `SendExternalBulk.test.ts > un recipient delivered sigue contando…` + `…skipped/opted_out NO quema cupo…` | ✅ |
| VAL-7 | previews no consumidos no descuentan | `ValidateExternalBulk.test.ts > previews NO consumidos no descuentan cupo` | ✅ |
| VAL-8 | dos validate idénticos → dos previews | `ValidateExternalBulk.test.ts > dos validate idénticos generan DOS previews independientes` | ✅ |
| VAL-9 | respuesta completa mixta | `ValidateExternalBulk.test.ts > batch mixto: counts cuadran a mano` + `external-messaging.routes.test.ts > 200 en el camino feliz — respuesta con la forma D12/VAL-9` | ✅ |
| VAL-10 | override por-recipient gana | `ValidateExternalBulk.test.ts > el valor por-recipient pisa al global por key` | ✅ |
| VAL-10 | variable faltante invalida solo a ese recipient | `ValidateExternalBulk.test.ts > variable faltante invalida SOLO a ese recipient` | ✅ |
| VAL-10 | variable extra permitida e ignorada | `ValidateExternalBulk.test.ts > variable EXTRA no declarada — permitida e ignorada` + `fix wave F1 (F12) > una key extra no declarada no queda en el preview persistido` | ✅ — F12 amendment (filtered to declared keys) also covered |
| VAL-10 | el hash distingue variables por-recipient | `ValidateExternalBulk.test.ts > el hash distingue el variables de UN recipient` + `externalBulkPayloadHash.test.ts > cambiar el variables de UN recipient produce un hash DISTINTO` | ✅ |
| SEND-1 | sin Idempotency-Key | `SendExternalBulk.test.ts` + `external-messaging.routes.test.ts > sin Idempotency-Key → 400 (SEND-1)` | ✅ |
| SEND-2 | previewId inexistente / vencido / consumido-por-otra-key | `SendExternalBulk.test.ts` — 3 tests, all present | ✅ |
| SEND-2 | vencido Y consumido → gana 410 (F10 amendment) | `SendExternalBulk.test.ts > fix wave F1 (F10) > preview VENCIDO y ademas consumido → PREVIEW_EXPIRED (410), no PREVIEW_ALREADY_CONSUMED` | ✅ — order-swap amendment explicitly pinned, plus a companion "consumido pero vigente → 409" test |
| SEND-3 | hash distinto | `SendExternalBulk.test.ts > hash re-calculado no matchea el guardado → PreviewPayloadMismatchError` | ✅ |
| SEND-4 | template desaprobado entre validate y send | `SendExternalBulk.test.ts > template pasó a pending/rejected DESPUÉS del validate` | ✅ |
| SEND-4 | cupo agotado entre validate y send | `SendExternalBulk.test.ts > cupo diario agotado por OTRA campaña api-messaging` | ✅ |
| SEND-4 | opt-out entre validate y send | `SendExternalBulk.test.ts > recipient opt-out DESPUÉS del validate → excluido` | ✅ |
| SEND-5 | recipient sin name | `SendExternalBulk.test.ts > recipient sin name real (name === phone del preview)` | ✅ |
| SEND-5 | chatwootLabel propagado | `SendExternalBulk.test.ts > chatwootLabel del preview propagado a la Campaign` | ✅ |
| SEND-6 | kill-switch también apaga el replay (F3 amendment) | `SendExternalBulk.test.ts > fix wave F1 (F3) > (a) flag apagado DESPUES del send → el replay tambien responde FEATURE_DISABLED` | ✅ |
| SEND-6 | replay sobre campaña terminada (done/failed → resumed:false, sin start) | `SendExternalBulk.test.ts > (b) campana done/failed → 200 idempotente {resumed:false,…}` (2 tests) | ✅ |
| SEND-6 | replay sobre campaña running | `SendExternalBulk.test.ts > (b) campana running → resumed:true SIN llamar start` | ✅ |
| SEND-6 | carrera de dos send con la misma key (F5) | `SendExternalBulk.test.ts > F5 — dos send concurrentes con la MISMA key…` + fix wave F2 NEW-1 companion test | ✅ |
| SEND-6 | doble POST idéntico → misma campaignId | `SendExternalBulk.test.ts > SEND-6: MISMA key + MISMO previewId ya consumido…` + route test `replay (misma key + mismo preview) → 200 con {resumed,status}` | ✅ — `resumed`/`status` fields on the wire, confirmed at route level too |
| SEND-7 | reuso de key con otro preview | `SendExternalBulk.test.ts > SEND-7: misma key usada por OTRO previewId…` | ✅ |
| SEND-8 | lock tomado | `SendExternalBulk.test.ts > runner ocupado en el PRIMER intento → 409…` | ✅ |
| SEND-8 | retry tras liberarse el lock | same test, second half — reanuda la MISMA campaña | ✅ |
| SEND-9 | send exitoso | `SendExternalBulk.test.ts > flag ON, topes OK, runner libre → {campaignId, accepted:true, total}` | ✅ |
| SEND-10 | cada destinatario recibe su mensaje | `SendCampaign.test.ts` (+6 SEND-10 cases, override in 3 consumption points) | ✅ |
| SEND-10 | override sobre variable resuelta del Client | `SendCampaign.test.ts` — "gana sobre source:name" case | ✅ |
| SEND-10 | campaña UI admin sin regresión | `SendCampaign.test.ts` — mandatory `variables:null` non-regression case | ✅ |
| TPL-0 | flag OFF apaga templates | `external-messaging-templates.routes.test.ts > flag OFF → 403 FEATURE_DISABLED en las 4 rutas` + composition test (extended to 6 endpoints) | ✅ |
| TPL-0 | key global no abre templates | `external-messaging-templates.routes.test.ts > key global (equivocada acá) → 401` | ✅ |
| TPL-1 | listado mixto | `external-messaging-templates.routes.test.ts > 200 con TODOS los templates (mixto approved/pending)` | ✅ |
| TPL-2 | consulta de estado / sid inexistente | `external-messaging-templates.routes.test.ts` — 2 tests | ✅ |
| TPL-3 | creación válida / body vacío / category fuera de enum | `external-messaging-templates.routes.test.ts` — 3 tests, + tipo-equivocado test (D7.d) | ✅ |
| TPL-4 | submit válido / name vacío / category inválida / sid inexistente | `external-messaging-templates.routes.test.ts` — 4 tests | ✅ |
| TPL-5 | intento de DELETE | `external-messaging-templates.routes.test.ts > 404 — la ruta NO está registrada, deleteTemplate NUNCA se invoca` | ✅ |
| STATUS-1 | campaña propia | `GetExternalBulkCampaign.test.ts` + route test `propia → 200` | ✅ |
| STATUS-1 | campaña de la UI admin | `GetExternalBulkCampaign.test.ts` + route test `ajena/inexistente → 404` | ✅ |
| STATUS-1 | **GET /campaigns/:id NOT gated by kill-switch** | Code confirmed (`router.get('/campaigns/:id', …)` does NOT call `isFeatureEnabled()`, unlike every other handler) — **but no test exercises this with flag OFF** | ⚠️ PARTIAL (WARNING, see below) |
| CONFIG-1 | primera lectura sin config | `GetExternalBulkConfig.test.ts > sin fila previa devuelve los defaults 500/2000` + route test | ✅ |
| CONFIG-2 | GET sin messaging:read / PUT sin messaging:manage | `externalBulkMessagingConfig.routes.test.ts` — both gates tested | ✅ |
| CONFIG-3 | valores inválidos / maxPerRequest > maxPerDay | `SetExternalBulkConfig.test.ts` — 5 cases + route test | ✅ |
| CONFIG-3 | maxPerRequest > 5000 hard cap (F4 amendment) | `SetExternalBulkConfig.test.ts > fix wave F1 (F4) … rechaza > MAX_MANUAL_CONTACTS…` + `acepta exactamente MAX_MANUAL_CONTACTS` + `ValidateExternalBulk.test.ts > clamp defensivo` | ✅ — both the PUT-side reject and the validate-side defensive clamp are covered |
| AUDIT-1 | actor auditado es api-messaging | `external-messaging.routes.test.ts > validate 200 → fila de auditoria con actorLogin api-messaging` (+ send 202/409 case) | ✅ |
| AUDIT-1 | validate rechazado (CAP_EXCEEDED) también audita | `external-messaging.routes.test.ts > validate 422 CAP_EXCEEDED → el RECHAZO tambien queda auditado` | ✅ |
| AUDIT-1 | send exitoso audita campaignId | `external-messaging.routes.test.ts > send exitoso queda auditado con el campaignId creado` | ✅ |
| AUDIT-2 | creación de template auditada | `external-messaging-templates.routes.test.ts > POST /templates exitoso pasa por auditMutationsMiddleware` + `GET /templates NO genera mutación auditada` | ✅ |
| COMP-1 | orden de mounts (composition-root) | `external-bulk-messaging-composition.test.ts` — static index check + supertest key-global-401 + key-dedicada-pasa-auth | ✅ (see DEVIATION note below — not a literal `createApp()` boot, justified) |

**Compliance summary**: **78/79 scenarios ✅ COMPLIANT**, **1/79 ⚠️ PARTIAL (WARNING)**, **0 ❌ UNTESTED/FAILING**.

---

## Correctness (Static — Structural Evidence)

| Requirement group | Status | Notes |
|---|---|---|
| AUTH-1/2/3 | ✅ Implemented | `createApiKeyMiddleware(config.externalMessaging.apiKey)`, fail-closed on empty key |
| KS-1 | ✅ Implemented | Checked first in both use cases; router-level gate for the 4 template routes (D4.f — those use cases lack their own gate) |
| VAL-1..10 | ✅ Implemented | Order matches D0/task 2.5 reconciliation, documented inline |
| SEND-1..10 | ✅ Implemented | GUARD-0 → flag → preview lifecycle → hash → re-validation → CreateCampaign → markConsumed → runner.start, per D0 |
| TPL-0..5 | ✅ Implemented | Zero new use cases (D4.f), `deleteTemplate` genuinely not injected into router deps |
| STATUS-1 | ✅ Implemented | Scoped to `createdById === api-messaging`; not gated by kill-switch (D12 amendment, F15) — code confirmed, test gap noted above |
| CONFIG-1..3 | ✅ Implemented | Singleton lazy-upsert (F14 fix); 5000 hard cap (F4 fix) both at PUT and defensive clamp at validate-time |
| AUDIT-1/2 | ✅ Implemented | `machineActorMiddleware` (F6 fix) replaces the `anonymous`/`console.log` original approach |
| COMP-1 | ✅ Implemented | Mount registered before the global `/api/external/v1`, pinned via marker `[external-bulk-mount-end]` + static index check |

---

## Coherence (Design)

| Decision | Followed? | Notes |
|---|---|---|
| D1 (schema, 2 tables + 1 column, additive) | ✅ Yes | Verified `schema.prisma` ↔ migration SQL byte-for-byte field match |
| D2 (bootstrap `api-messaging`, not migration seed) | ✅ Yes | `bootstrapApiMessagingUser` wired in `main.ts` |
| D3/D3.a (2 new ports + `CampaignRepository` +2 methods) | ✅ Yes | `countAuthorizedRecipientsByCreatorSince` — name matches the F2-amended design exactly |
| D4.a (CampaignStarter structural interface) | ✅ Yes | |
| D4.e (variables per-recipient, 8-point chain) | ✅ Yes | All 8 points traced and tested; non-regression test present |
| D5 (payload hash) | ✅ Yes | Matches implementation signature exactly |
| D6 (daily cap semantics, F2-amended) | ✅ Yes | `countAuthorizedRecipientsByCreatorSince`, K1/K2/K3 test pins it |
| D7 (router order, body parser placement — F1-amended) | ✅ Yes | Parser moved to path-scoped block before global; pinned by 3 tests (static order, mechanic 200-vs-413, explicit counterfactual with the OLD order) |
| D7.b (audit — F6-amended) | ✅ Yes | `console.log` removed, `machineActorMiddleware` added |
| D8 (markConsumed after CreateCampaign) | ✅ Yes | Test pins the order via a forced-false `markConsumed` spy |
| D9 (TTL lazy + best-effort purge) | ✅ Yes | |
| D10 (config/env, opt-in not in REQUIRED_VARS) | ✅ Yes | `env.example` + `config.ts` + `deploy.yml` all confirmed wired |
| D12 (wire contract) | ✅ Yes | Verified against both BE route responses and FE types — flat shape, no envelope, identical field names |
| D13 (FE minimum) | ✅ Yes | Card + hooks + api client all exist and match D13's description; not in BE `tasks.md` as checked (see WARNING) |
| Rejected alternatives (SQL seed for `api-messaging`, FK on `campaignId`, scheduler job for TTL, second `CampaignRunner` instance) | ✅ None accidentally implemented | Confirmed absent by reading the actual composition-root wiring |

---

## Issues Found

**CRITICAL** (must fix before archive): **None.**

**WARNING** (should fix):
1. **`tasks.md` Batch 5 (FE) checkboxes unchecked** despite the FE implementation being complete and
   its 52 tests passing (`ipnext-frontend/.claude/worktrees/external-bulk-messaging-fe`). Documentation
   sync gap between the two repos' artifact trails — check off 5.1-5.4 + Gate B5 before archive.
2. **STATUS-1 "GET /campaigns/:id not gated by the kill-switch" has no test.** The code is correct
   (`external-messaging.routes.ts:165` — the `/campaigns/:id` handler does not call `isFeatureEnabled()`,
   unlike every other handler in the same file) and the design explicitly documents this as intentional
   (D12 amendment, fix-wave finding F15). But no test in `external-messaging.routes.test.ts` or
   `external-bulk-messaging-composition.test.ts` calls `GET /campaigns/:id` with the flag OFF to prove
   it still returns 200 (or 404-for-unknown-id, i.e. anything but 403). The composition test's
   `flag OFF → 403 FEATURE_DISABLED en validate/send/templates` block covers 6 endpoints but skips this
   one — likely deliberate omission rather than oversight, but it leaves the one deliberately-different
   behavior in the whole router as the one path with zero behavioral proof.

**SUGGESTION** (nice to have):
1. Re-run `npx tsc --noEmit` once more immediately before merge/archive, given the transient
   cache-related false-failure observed mid-session (see Build & Tests section above) — low risk, but
   cheap to confirm since this session's sandbox couldn't rule out a concurrent-process race on the
   shared worktree.
2. `ValidateExternalBulk.test.ts`'s `describe('VAL-7 — tope diario (maxPerDay) sobre lo REALMENTE
   enviado', …)` title still says "lo REALMENTE enviado" (the pre-F2 semantics), while the code and the
   actual amendment-pinning test live in `SendExternalBulk.test.ts` under the F2 fix-wave describe
   block. Not a functional gap — the correct behavior IS tested — but the stale title in
   `ValidateExternalBulk.test.ts` could mislead a future reader into thinking VAL-7's amendment isn't
   reflected there. Cosmetic rename recommended.

---

## Verdict

**PASS WITH WARNINGS**

All 79 spec scenarios traced to a passing test except one (STATUS-1's kill-switch-exemption for
`GET /campaigns/:id`, which is correctly implemented but untested). Both fix-wave amendments (F1: 15
findings, F2: 2 findings) are consistently reflected across spec.md, design.md, and the actual test
suite — including the specific amendments the orchestrator asked to double-check (replay 200 +
resumed/status, daily cap = authorized recipients, foreign numbers → telefono_invalido, variables
filtered to declared keys, 410 before 409, GET /campaigns/:id not gated). Migration SQL is additive and
matches schema.prisma field-for-field. `deploy.yml`/`env.example` both carry
`EXTERNAL_MESSAGING_API_KEY`. FE contract mirrors BE exactly (flat `{maxPerRequest,maxPerDay,updatedAt}`,
identical flag-key string). The only blocking-adjacent item is a documentation sync gap in `tasks.md`
(Batch 5 unchecked despite being done) — recommend fixing that before archive, but nothing here blocks
merging the code itself.
