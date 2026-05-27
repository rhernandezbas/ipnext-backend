# Archive Report: scheduling-hardening

**Archived**: 2026-05-11  
**Status**: Completed — PASS WITH WARNINGS (all warnings resolved in batch 2)  
**Final tests**: 349/349 passing  
**Final tsc --noEmit**: clean

## Cycle Summary

| Phase | Outcome |
|-------|---------|
| Propose | 5 defects identified, scope defined |
| Spec | 32 REQ-* across 11 sections |
| Design | 5 architecture decisions |
| Tasks | 26 tasks across 6 phases |
| Apply (batch 1) | 26/26 complete, 342/342 tests, strict TDD |
| Verify | PASS WITH WARNINGS — 22✅ 8⚠️ 0❌ |
| Apply (batch 2) | 5/5 post-verify fixes; 7 new tests; W-4 was a real bug |
| Archive | This report |

## Engram Observation IDs (traceability)

- proposal: #66
- spec: #68
- design: #67
- tasks: #69
- apply-progress: #70
- verify-report: #71

## Specs Synced

- NEW: `openspec/specs/scheduling/spec.md` (32 requirements, 32 scenarios) — no prior spec existed.

## Files Touched (production code)

| File | Action |
|------|--------|
| `src/domain/entities/scheduling.ts` | Modified — 5 fields relaxed to `string \| null` |
| `src/application/dto/scheduling.dto.ts` | Created — zod schemas |
| `src/infrastructure/http/routes/scheduling.routes.ts` | Modified — auth + zod + AuthProvider port |
| `src/infrastructure/http/app.ts` | Modified (line 515) — pass authAdapter |
| `src/infrastructure/http/middleware/authMiddleware.ts` | Modified — widened to AuthProvider port |
| `src/infrastructure/adapters/prisma/PrismaSchedulingRepository.ts` | Modified — toTask `?? null`, include project, toTask exported |
| `src/infrastructure/adapters/in-memory/InMemorySchedulingRepository.ts` | Modified — fixtures now have projectId/projectName |
| `src/__tests__/infrastructure/scheduling.routes.test.ts` | Modified — FakeAuthProvider, +16 new tests |
| `src/__tests__/infrastructure/PrismaSchedulingRepository.toTask.test.ts` | Created — 4 unit tests |
| `package.json` | Modified — zod ^4.4.3 added |

## Frontend Coordination (NOT part of this change)

The frontend team must, in coordination:
- Update `ipnext-frontend/src/types/scheduling.ts:7-11` — `description`, `assignedTo`, `assignedToId`, `address`, `notes` → `string | null`
- Add `?? ''` guards in components that call string methods on those fields
- No api/hook changes needed

## Follow-ups (out of scope for this change)

- Migrate remaining routes (`clients`, `tickets`, `billing`, etc.) to use `AuthProvider` port instead of `JwtAuthAdapter` (precedent set here)
- Migrate other modules to zod validation (precedent set here)
- Address known debt items from `openspec/config.yaml.known_debt` (naming, DIP in Report use-cases, app.ts god object)
