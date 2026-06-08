# Design: Audit Degeneration Retry (Map-Reduce Fallback)

## Technical Approach

Keep `audit()`'s fast path UNCHANGED: download/encode photos ONCE, then one full multimodal call (`renderPrompt` + all images + `auditFormatSchema()` + `temperature:0`) → `parseAuditResult`. On `ok:true` return. On `ok:false` AND photos exist AND map-reduce enabled, fall back to MAP-REDUCE that keeps every photo but never loads them all into one prompt: MAP runs one free-text describe call per cached base64 image (single image, NO schema); REDUCE runs one TEXT-ONLY call (`images:[]`) with `renderSynthesisPrompt` + `auditFormatSchema()` + `temperature:0` → `parseAuditResult`. Return synthesis result, else `{ok:false}`. No-photo or disabled → today's `{ok:false}`. All transport stays `fetch` → `/api/generate`.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| Fallback shape | Map-reduce (1×1 describe + text-only synthesis) | Photo-reduction ladder (drop photos) | Preserves ALL photos as context; spreading images across N small calls avoids the multimodal degeneration root cause |
| Map prompt | Free text, NO schema | Schema-constrained | 1 image + short prompt = minimal load; free text tolerates noise and won't itself need the findings grammar |
| Reduce prompt | Text-only, reuse `renderPrompt` structure + "Observaciones por foto" + schema | Re-send images | Text-only call removes the multimodal load that degenerated attempt 1 |
| Trigger | `parseAuditResult` `ok:false` + photos>0 + flag on | Always map-reduce; retry-same | Fallback-only keeps the cheap path; the signal is the existing degeneration signal |
| Config | `mapReduceOnDegeneration?: boolean` default `true` | Threshold/env-only | Simple ctor opt; default ON; rollback = set false. `maxPhotos` stays 8 |
| Download seam | Reuse the SAME `images[]` base64 array from attempt 1 | Re-fetch per map call | Already downloaded once at top of `audit()`; map loop iterates that array — no re-fetch |

## Data Flow

    audit(ctx)
      └─ fetchB64 × urls (ONCE) ──→ images[] (base64)
           │
           ├─ Attempt 1: ask(renderPrompt, images, schema) ─→ parse ─ ok? ─→ return
           │                                                       │ no
           │                  (photos>0 && flag)  ◄────────────────┘
           ▼
         MAP:  for each img in images[]:
                 ask(renderPhotoDescribePrompt, [img], NO schema) ─→ obs[i] (free text)
           ▼
        REDUCE: ask(renderSynthesisPrompt(ctx, obs[]), [], schema) ─→ parse ─→ return
                                                                          │ no
                                                                          ▼  {ok:false}

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/infrastructure/adapters/audit/OllamaInstallationAuditor.ts` | Modify | Add `mapReduceOnDegeneration` ctor opt (default true); extend `ask` with a schema toggle; add `renderPhotoDescribePrompt()` + `renderSynthesisPrompt(ctx, obs)`; on attempt-1 soft-fail run map-reduce; per-step logging |
| `src/__tests__/infrastructure/OllamaInstallationAuditor.test.ts` | Modify | Add map-reduce tests: degeneration → N describe + 1 synthesis; call counts; per-call images.length; schema presence; download-once |

## Interfaces / Contracts

```ts
export interface OllamaAuditConfig {
  baseUrl: string; model: string;
  timeoutMs?: number; downloadTimeoutMs?: number; maxPhotos?: number;
  /** On attempt-1 parse soft-fail, fall back to 1×1 map + text-only synthesis. Default true. */
  mapReduceOnDegeneration?: boolean;
}
// ask gains a schema toggle so describe calls omit `format`:
private ask(prompt: string, images: string[], useSchema: boolean): Promise<string>
// when useSchema is false, the request body omits `format` (free text); temperature:0 stays.
```

`renderPhotoDescribePrompt()` → "Describí en 2-3 frases qué se ve en esta foto de instalación relevante para la calidad (equipos, conexiones, prolijidad, señal). Texto plano." (free text, no JSON instruction).

`renderSynthesisPrompt(ctx, observations)` → reuse `renderPrompt`'s context blocks + the SAME findings-JSON instruction and no-false-warning line, TEXT-ONLY, appending an `Observaciones por foto:` section listing the N observations. `renderPrompt` stays as-is for attempt 1.

## Logging

- Keep the existing pre-call info log (downloaded count) and the attempt-1 soft-fail raw-sample `console.warn`.
- On degeneration with photos: `[audit] OS X: degeneración con N fotos — map-reduce (1x1 + síntesis)`.
- Per-map step optional (debug). On synthesis: log success or, on soft-fail, the existing raw-sample warn then `{ok:false}`.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|--------------|----------|
| Unit | Attempt-1 success = 1 `/api/generate` call (unchanged) | Single response returns valid array |
| Unit | Degeneration → N+2 calls (1 full + N describe + 1 synthesis) | Response **queue**: 1st = `<\|im_start\|>` garbage, next N = describe text, last = valid array |
| Unit | `images.length` per call: full=N, each describe=1, synthesis=0 | Capture each `init.body`; assert per-call images length |
| Unit | Schema on attempt-1 + synthesis, ABSENT on describe | Assert `format` equals `auditFormatSchema()` on calls 1 & last, `undefined` on describe calls |
| Unit | Download-once | Count fetches whose URL is a photo URL (not `/api/generate`) = N, even on fallback |
| Unit | Flag off / no photos → `{ok:false}`, no map-reduce | Assert single `/api/generate` call |
| Regression | Existing F6-R8 + happy path | `photoUrls: []` → single call, no fallback |

Test seam: keep the `global.fetch` override. Sequence `/api/generate` responses via a FIFO queue (shift per call); route photo-URL fetches by URL prefix returning a fake image buffer (`arrayBuffer`). Photo tests must set `photoUrls` (existing tests use `[]`, so they stay single-call). Distinguish call kinds by `url.endsWith('/api/generate')`.

## Migration / Rollout

No migration. Config-gated: `mapReduceOnDegeneration:false` restores single-call behavior. `maxPhotos` stays 8; structured outputs + `temperature:0` retained on attempt 1 and synthesis.

## Open Questions

- None.
