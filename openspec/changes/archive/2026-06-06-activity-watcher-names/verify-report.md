# Verify report: activity-watcher-names (#17) — BE

**Mode**: Strict TDD · **Scope**: backend (FE phase verifies separately before its own deploy)

## Build & Tests
- **Build**: `npx tsc --noEmit` → exit 0 ✅
- **Tests**: `npx jest --runInBand` → **2376 passed, 0 failed**, 86 skipped ✅

## Spec Compliance Matrix

| Requirement | Scenario | Test (passed) | Result |
|-------------|----------|---------------|--------|
| Watcher events carry the watcher's name | adding a watcher records the name | `computeUpdateTaskActivities › watcher events carry the name from watcherNames` + `UpdateTask.activity › records watcher add/remove with the resolved name` | ✅ COMPLIANT |
| | removing a watcher records the name | idem (`fromName` branch) | ✅ COMPLIANT |
| | unresolvable name degrades gracefully | `computeUpdateTaskActivities › watcher events fall back to no name when the id is not in watcherNames` | ✅ COMPLIANT |

**Compliance**: 3/3 scenarios COMPLIANT (each proven by a passing test).

## Completeness
- BE tasks 1-5: ✅ done.
- Pending (separate phases): 6 (commit+deploy BE), 7-9 (FE `taskActivityLabel.ts` + its verify+deploy), 10 (final verify).

## Coherence (design)
- Approach B implemented as designed: `EntityLookup` (+name optional), `userLookupForScheduling` returns name, `UpdateTask` resolves union prev∪data, `computeUpdateTaskActivities` `watcherNames?` param. No deviation. No migration (metadata jsonb).

## Verdict
**PASS** (BE). Safe to commit + deploy — the audit reprocess is stopped (60/76), so the deploy won't cut it.
