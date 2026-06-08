# audit-degeneration-retry Specification

## Purpose

Defines the degeneration-recovery behavior of `OllamaInstallationAuditor.audit()`. When the full multimodal attempt returns degenerate output (`parseAuditResult` ok=false), the auditor MUST fall back to a map-reduce flow — one free-text describe call per photo, then one text-only synthesis call — rather than dropping photos or retrying with fewer images.

## Requirements

### Requirement: Fast Path — Attempt 1 Returns on First Parse Success

The auditor MUST make exactly one full multimodal model call (up to `maxPhotos`=8 images, `auditFormatSchema()`, `temperature:0`). If `parseAuditResult` succeeds, return immediately. No map-reduce is triggered.

#### Scenario: Attempt 1 parses ok

- GIVEN the model transport returns valid JSON on the first (multimodal) call
- WHEN `audit()` is invoked
- THEN the auditor returns the parsed result
- AND the model transport is called exactly once total

---

### Requirement: Degeneration Triggers Map-Reduce Fallback (Config ON)

When `parseAuditResult` returns `{ok:false}` on attempt 1 AND the map-reduce flag is enabled (default ON), the auditor MUST execute a MAP step followed by a REDUCE step.

**Map**: for EACH downloaded photo, one model call with that single image and a free-text describe prompt (no schema). Returns a per-photo textual observation.

**Reduce**: one TEXT-ONLY model call (no images) with the full context and all per-photo observations, using `auditFormatSchema()` + `temperature:0`. If `parseAuditResult` succeeds, return the result.

#### Scenario: Map calls are per-photo, single-image, free-text

- GIVEN attempt 1 soft-fails (degeneration)
- AND there are N downloaded photos
- WHEN the map step executes
- THEN exactly N model calls are made, each carrying exactly 1 image (`images.length === 1`)
- AND none of these calls include `auditFormatSchema()` (free-text, no schema)

#### Scenario: Reduce call is text-only and structured

- GIVEN the map step has produced N per-photo observations
- WHEN the reduce (synthesis) call is made
- THEN the call carries `images === []` (no images)
- AND the call includes `auditFormatSchema()` and `temperature:0`

#### Scenario: Map-reduce success returns structured findings

- GIVEN attempt 1 soft-fails
- AND the synthesis call parses ok
- WHEN `audit()` completes
- THEN the auditor returns the parsed findings from synthesis
- AND total model calls equal 1 (attempt 1) + N (map) + 1 (synthesis)

#### Scenario: Per-step soft-fail is logged

- GIVEN attempt 1 produces `parseAuditResult` ok=false
- WHEN `audit()` processes the degeneration
- THEN a soft-fail log entry including the OS code and the step (attempt-1 / map / synthesis) is emitted

---

### Requirement: Synthesis Parse-Fail Returns ok:false

If the synthesis (reduce) call also returns `parseAuditResult` ok=false, the auditor MUST return `{ok:false}`. The use-case `auditAttempts` limit still applies.

#### Scenario: Synthesis parse-fail → ok:false

- GIVEN attempt 1 soft-fails AND synthesis also soft-fails
- WHEN `audit()` completes
- THEN the auditor returns `{ok:false}`

---

### Requirement: Config OFF Disables Map-Reduce

When the map-reduce flag is disabled, the auditor MUST behave as before: attempt 1 only; on soft-fail, return `{ok:false}` without any map or reduce calls.

#### Scenario: Flag OFF — degeneration yields ok:false with one model call

- GIVEN the map-reduce flag is OFF
- AND attempt 1 soft-fails
- WHEN `audit()` completes
- THEN the auditor returns `{ok:false}`
- AND the model transport is called exactly once total

---

### Requirement: Download Once — Map Calls Reuse In-Memory Base64

Photos MUST be downloaded and base64-encoded once per `audit()` invocation (for attempt 1 + map step). The fetch function MUST NOT be called again during the map step.

#### Scenario: Map calls reuse cached photos — no re-fetch

- GIVEN N photos are downloaded for attempt 1
- WHEN the map step executes N model calls
- THEN the photo fetch function is called exactly N times total across the whole invocation (once per photo at download time)
- AND no additional fetches occur during the map step

---

### Requirement: No-Photos Edge Case

When there are no photos, attempt 1 is text-only. If it soft-fails, the map step has no photos to iterate — the auditor MUST skip the map step and return `{ok:false}` directly (no synthesis call, no empty-map loop).

#### Scenario: No photos, attempt 1 fails → ok:false without map-reduce

- GIVEN the OS has zero photos
- AND attempt 1 (text-only) soft-fails
- WHEN `audit()` completes
- THEN the auditor returns `{ok:false}`
- AND no map calls and no synthesis call are made (total model calls = 1)

---

### Requirement: Attempt 1 and Synthesis Always Use Structured Outputs

Both the full multimodal attempt and the synthesis (reduce) call MUST include `format: auditFormatSchema()` and `temperature:0`. Map (describe) calls MUST NOT include the findings schema.

#### Scenario: Structured outputs on attempt 1 and synthesis

- GIVEN a normal audit invocation (any photo count)
- WHEN the model calls for attempt 1 and synthesis are made
- THEN both include `auditFormatSchema()` and `temperature:0`
- AND map describe calls do NOT include `auditFormatSchema()`
