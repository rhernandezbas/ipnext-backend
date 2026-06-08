# Proposal: Audit Degeneration Retry (Map-Reduce Fallback)

## Intent

When the closure-audit reprocess drains with Ollama up, some multi-photo OS make `qwen2.5vl:7b` DEGENERATE: it emits repeated garbage tokens (`<|im_start|>` in a loop) instead of valid JSON. `parseAuditResult` returns `{ok:false}` → the audit is NOT persisted. The long multimodal prompt (up to 8 photos + #20-enriched context) tips the model over. We need the adapter to react to the degeneration signal WITHOUT dropping photos — every photo is context the audit needs. Strategy: try the full multimodal prompt first (fast path), and on degeneration fall back to MAP-REDUCE that keeps ALL photos but never loads them all into one prompt.

## Diagnosis

Prod VPS log (intermittent):
- OS 4564 (3 photos): `[audit] OS 4564: parse soft-fail. Respuesta cruda del modelo: [` + `"text": "fmt<|im_start|><|im_start|>...` → degenerated.
- OS 4563 (4 photos): worked.

Code facts (verified live):
- `OllamaInstallationAuditor.audit()` makes ONE model call; on `parseAuditResult` ok=false it logs the soft-fail and returns ok=false — NO retry.
- Already uses structured outputs (`format: auditFormatSchema()` + `temperature:0`); degeneration still happens on big multimodal prompts.
- `parseAuditResult` is the degeneration signal (no `[...]` match or JSON throw → `{ok:false}`). Pure, never throws.
- Root cause: multimodal load (many images in one prompt) tips the model. Spreading images across N small calls avoids it.

## Scope

### In Scope
- Keep Attempt 1 UNCHANGED: one full multimodal call (≤ `maxPhotos`=8 images + #20 prompt + `auditFormatSchema()` + `temperature:0`). Most OS resolve here cheaply.
- On parse soft-fail → MAP-REDUCE fallback (preserves ALL photos):
  - **Map (1x1)**: per photo, one model call with that SINGLE image + a short "describe what's relevant in this installation photo" prompt → free-text per-photo observation.
  - **Reduce**: one TEXT-ONLY call (no images) with full #20 context + the N observations → structured findings JSON (`auditFormatSchema()` + `temperature:0`).
  - Synthesis still parse-fails → return `{ok:false}` (use-case `auditAttempts` still applies).
- Download/encode photos ONCE at `maxPhotos`; reuse base64 for the full attempt AND the map calls. No re-fetch.
- Two new prompt templates: per-photo describe (free text) and synthesis (audit structure + "Observaciones por foto" section, text-only).
- Config flag/threshold to skip map-reduce (default ON). `maxPhotos` stays 8.
- Tests with mocked transport: degeneration on attempt 1 → N map calls + synthesis → ok result.

### Out of Scope
- Always-map-reduce (fallback-only chosen).
- Changing the model or adding VRAM (infra).
- Batching >1 photo per map call (1x1 chosen).
- Reverting structured outputs / `temperature:0`.

## Capabilities

### New Capabilities
- `audit-degeneration-retry`: the Ollama auditor adapter MUST, on a parse soft-fail of the full multimodal attempt, fall back to a map-reduce flow — one free-text describe call per photo, then one text-only synthesis call producing the structured findings — returning the first valid result and falling back to `{ok:false}` only when synthesis also fails.

### Modified Capabilities
- None.

## Approach

In `audit()`: download/encode photos ONCE at `maxPhotos`. **Attempt 1**: the existing single multimodal `ask` + `parseAuditResult`; on `ok:true` return. On `ok:false`, if map-reduce enabled: **Map** — for each cached base64 image, call `ask` with that one image + the describe template (free text), collect observations. **Reduce** — call `ask` with the synthesis template (full #20 context + "Observaciones por foto" listing the N observations, NO images) + `auditFormatSchema()` + `temperature:0`; `parseAuditResult` → return on ok. Else return final `{ok:false}`. Per-step soft-fail logging (OS code + step).

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/infrastructure/adapters/audit/OllamaInstallationAuditor.ts` | Modified | Download-once; attempt-1 full call; map-reduce fallback; new templates; config flag; per-step logging |
| `src/__tests__/...OllamaInstallationAuditor*` | New/Modified | Mocked-transport tests: attempt-1 success path; degeneration → N map + synthesis success |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Extra latency (N+1 calls on fallback) | Med | Fallback only on degeneration; reprocess is async/background (#23/#32/#33) |
| Synthesis loses photo nuance vs raw image | Low | Per-photo describe captures relevant detail; richer than dropping photos entirely |
| Map call itself degenerates | Low | 1 image + short prompt = minimal load; free-text (no schema) tolerates noise |

## Rollback Plan

Set the map-reduce flag OFF via config to restore single-call behavior (attempt 1 only), or revert the adapter change. No schema/migration — pure adapter logic.

## Dependencies

- Ollama reachable (existing). No new external deps.

## Success Criteria

- [ ] Attempt 1 (full multimodal) returns the parsed result unchanged when the model behaves.
- [ ] On a degenerated attempt 1, the adapter runs N per-photo describe calls + 1 text-only synthesis and returns the parsed result when synthesis succeeds — using ALL photos, none dropped.
- [ ] When synthesis also degenerates, `audit()` returns `{ok:false}` (unchanged use-case behavior).
- [ ] Photos downloaded once; map-reduce is config-gated (default ON); `maxPhotos` stays 8; structured outputs + `temperature:0` retained on attempt 1 and synthesis.
- [ ] Mocked-transport tests pass; no real Ollama call in tests.
