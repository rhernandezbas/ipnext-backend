# Tasks: Audit Degeneration Retry (Map-Reduce Fallback)

> Files: `src/infrastructure/adapters/audit/OllamaInstallationAuditor.ts` + `src/__tests__/infrastructure/OllamaInstallationAuditor.test.ts` only.
> TDD: RED → GREEN per task pair. `npx jest OllamaInstallationAuditor --runInBand`.

## Phase 1: Foundation — Download-Once Hoist + New Prompt Fns

- [x] 1.1 Add `mapReduceOnDegeneration?: boolean` to `OllamaAuditConfig`; wire in ctor (default `true`).
- [x] 1.2 Add `renderPhotoDescribePrompt(): string` — "Describí en 2-3 frases qué se ve en esta foto..." free text, NO JSON instruction.
- [x] 1.3 Add `renderSynthesisPrompt(ctx: AuditContext, observations: string[]): string` — reuses `renderPrompt` context blocks + `IMPORTANTE` + findings-JSON instruction + `\nObservaciones por foto:\n` listing N observations; text-only, no images.
- [x] 1.4 **RED** — Test: `renderPhotoDescribePrompt()` contains no JSON instruction and no schema keywords; `renderSynthesisPrompt` includes "Observaciones por foto" and the findings-JSON instruction.
- [x] 1.5 **GREEN** — Confirm tests pass; `renderPrompt` untouched.
- [x] 1.6 Extend `ask(prompt, images, useSchema: boolean): Promise<string>` — when `useSchema=false`, omit `format` from request body; `temperature:0` stays; default callers pass `true` (no regression).

## Phase 2: Map-Reduce Control Flow in `audit()` (RED → GREEN)

- [x] 2.1 **RED** — Scenario "Attempt 1 parses ok": `photoUrls` with N photos → transport called exactly once; `audit()` returns parsed result. (Spec: Fast Path)
- [x] 2.2 **RED** — Scenario "Map calls are per-photo, single-image, free-text": degeneration on attempt 1, N=2 photos → exactly 2 map calls each with `images.length===1` and NO `format` field. (Spec: Map shape)
- [x] 2.3 **RED** — Scenario "Reduce call is text-only and structured": after 2 map calls → synthesis call has `images===[]`, includes `format===auditFormatSchema()` and `temperature:0`. (Spec: Reduce shape)
- [x] 2.4 **RED** — Scenario "Map-reduce success returns structured findings": total calls = 1 + N + 1; `audit()` returns synthesis parsed result. (Spec: Map-reduce success)
- [x] 2.5 **RED** — Scenario "Synthesis parse-fail → ok:false": attempt 1 + N map + synthesis all garbage → `{ok:false}`. (Spec: Synthesis fail)
- [x] 2.6 **RED** — Scenario "Flag OFF — degeneration yields ok:false, one model call": `mapReduceOnDegeneration:false`, attempt 1 garbage → `{ok:false}`, transport called exactly once. (Spec: Config OFF)
- [x] 2.7 **RED** — Scenario "No photos, attempt 1 fails → ok:false without map-reduce": `photoUrls:[]`, attempt 1 garbage → `{ok:false}`, total model calls = 1, zero map calls. (Spec: No-photos edge)
- [x] 2.8 **RED** — Scenario "Map calls reuse cached photos — no re-fetch": N photos downloaded → map step runs → photo-URL `fetch` calls total = N (no re-fetch). (Spec: Download-once)
- [x] 2.9 **GREEN** — Implement map-reduce flow in `audit()`: hoist `fetchB64×urls` above attempt 1; attempt-1 block unchanged; on `ok:false` AND `images.length>0` AND flag: map loop → synthesis; else return `{ok:false}`. All 2.1–2.8 RED tests must go green.

## Phase 3: Logging (RED → GREEN)

- [x] 3.1 **RED** — Scenario "Per-step soft-fail is logged": attempt-1 degeneration emits `console.warn` containing OS code and step label (`attempt-1`); map-reduce entry emits info log with photo count; synthesis soft-fail emits its own warn. (Spec: Per-step logging)
- [x] 3.2 **GREEN** — Add per-step logs in `audit()`: keep existing pre-call `console.log` (download count); on attempt-1 soft-fail emit existing `console.warn` + `[audit] OS X: degeneración con N fotos — map-reduce (1x1 + síntesis)`; synthesis soft-fail emits raw-sample warn.

## Phase 4: Structured-Outputs Invariant + Final Verify

- [x] 4.1 **RED** — Scenario "Structured outputs on attempt 1 and synthesis": assert call 1 and synthesis call include `format===auditFormatSchema()` and `temperature:0`; assert map describe calls have no `format` field. (Spec: Structured outputs invariant)
- [x] 4.2 **GREEN** — Verify `ask(…, true)` passes schema, `ask(…, false)` omits it; fix if failing.
- [x] 4.3 Run `npx jest OllamaInstallationAuditor --runInBand` — all 11 scenario tests + existing regression tests green.
- [x] 4.4 Run `npx jest --runInBand` — full suite green (no regression in other tests).
- [x] 4.5 Run `npx tsc --noEmit` — zero type errors.
