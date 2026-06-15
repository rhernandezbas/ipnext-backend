/**
 * iclass-intermediate-states — Static composition guard for the status → stage AUTO-MOVE.
 *
 * The auto-move (move a matched task to the catalog row's prominenseStageId when the
 * captured IClass status changes) lives inside IngestClosedServiceOrders and rides on TWO
 * already-wired dependencies:
 *   1. statusCatalog (IClassStatusCatalogRepository) — to read prominenseStageId.
 *   2. PrismaSchedulingRepository — owns moveTaskToStageIfForward (the forward-only move).
 *
 * If either is dropped from any of the THREE production cron bootstraps, the auto-move
 * silently dies in prod (the exact "feature wired in app.ts but NOT in the cron bootstraps"
 * class of bug that FIX 1 fixed for iclass-status-sync). This guard reads the bootstrap
 * source as text and asserts both deps reach IngestClosedServiceOrders in all three.
 *
 * Uses the same static source-text pattern as bootstrap-iclass-status-catalog.test.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SCHEDULING_DIR = join(__dirname, '..', '..', 'infrastructure', 'scheduling');
const APP_PATH = join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts');

const BOOTSTRAPS = [
  'bootstrapIClassClosure.ts',
  'bootstrapBackfill.ts',
  'bootstrapTaskAutocomplete.ts',
] as const;

/**
 * Extract the positional arguments of the FIRST `new IngestClosedServiceOrders(...)` call,
 * respecting nesting: commas inside (), [] or {} do NOT split args. This lets us assert a
 * SPECIFIC positional dependency (the scheduling repo is the 4th arg) instead of a loose
 * regex over the whole arg blob — which would pass even if the dep appeared in the wrong
 * position or inside a comment.
 */
function extractIngestArgs(src: string): string[] {
  const start = src.indexOf('new IngestClosedServiceOrders(');
  if (start === -1) return [];
  let i = src.indexOf('(', start) + 1;
  let depth = 1;
  let current = '';
  const args: string[] = [];
  for (; i < src.length && depth > 0; i++) {
    const ch = src[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) break; // closing paren of the constructor call
    }
    if (ch === ',' && depth === 1) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) args.push(current.trim());
  return args;
}

describe('Bootstrap iclass-status AUTO-MOVE wiring (anti feature-dead guard)', () => {
  const srcByFile = new Map<string, string>();

  beforeAll(() => {
    for (const f of BOOTSTRAPS) srcByFile.set(f, readFileSync(join(SCHEDULING_DIR, f), 'utf8'));
  });

  describe.each(BOOTSTRAPS)('%s', (file) => {
    it('instantiates the status catalog repo (dep #1 — reads prominenseStageId)', () => {
      expect(srcByFile.get(file)).toContain('new PrismaIClassStatusCatalogRepository()');
    });

    it('passes the status catalog into IngestClosedServiceOrders (so the auto-move can read the mapping)', () => {
      const src = srcByFile.get(file)!;
      const match = src.match(/new IngestClosedServiceOrders\(([\s\S]*?)\)\s*;/);
      expect(match).not.toBeNull();
      expect(match![1]).toMatch(/[Cc]atalog/);
    });

    it('wires the scheduling repo as the 4th positional arg of IngestClosedServiceOrders (owns moveTaskToStageIfForward)', () => {
      const args = extractIngestArgs(srcByFile.get(file)!);
      // ctor: (iclass, closed, resultCodes, SCHEDULING_REPO, syncState, sideEffects)
      expect(args.length).toBeGreaterThanOrEqual(4);
      const schedulingArg = args[3]!;
      // Bootstraps pass it either inline as `new PrismaSchedulingRepository(...)` or via a
      // `schedulingRepo` variable — accept both, but it MUST be in the 4th slot specifically.
      expect(schedulingArg).toMatch(/new PrismaSchedulingRepository\(|schedulingRepo/);
    });
  });

  // The production forward-only move MUST exist on the Prisma adapter (the one the cron uses);
  // a missing method would make the auto-move a no-op at runtime even if wiring looks right.
  it('PrismaSchedulingRepository implements moveTaskToStageIfForward', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'adapters', 'prisma', 'PrismaSchedulingRepository.ts'),
      'utf8',
    );
    expect(src).toContain('moveTaskToStageIfForward');
  });

  // app.ts (the HTTP composition root) must keep the same wiring so the manual reprocess
  // endpoint exercises the auto-move identically to the cron.
  it('app.ts wires the status catalog into IngestClosedServiceOrders too', () => {
    const src = readFileSync(APP_PATH, 'utf8');
    const match = src.match(/new IngestClosedServiceOrders\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/[Cc]atalog/);
  });
});
