/**
 * Composition-root static source guard for iclass-ops-config (Ola A — AD-2).
 *
 * Reads app.ts as a plain string and asserts that:
 *  1) AutoAssignIClassTeamOnTaskUpdate is imported and instantiated.
 *  2) The autoAssignIClassTeam instance is passed into new UpdateTask(...) as an arg.
 *
 * Without this guard a silent refactor can drop autoAssignIClassTeam from the
 * UpdateTask constructor call and the auto-assign feature dies in prod with no
 * failing test — exactly the "feature muerta" class of bug.
 *
 * Pattern: same static string approach as iclass-os-actions-composition.test.ts and
 * projects-network-flag-composition.test.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('iclass-ops-config composition root (AD-2 auto-assign wiring)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  // ── Use case import + instantiation ─────────────────────────────────────────

  it('app.ts imports AutoAssignIClassTeamOnTaskUpdate', () => {
    expect(appSrc).toContain('import { AutoAssignIClassTeamOnTaskUpdate }');
  });

  it('app.ts instantiates AutoAssignIClassTeamOnTaskUpdate (const autoAssignIClassTeam = new ...)', () => {
    // Matches: const autoAssignIClassTeam = new AutoAssignIClassTeamOnTaskUpdate(
    expect(appSrc).toMatch(/const\s+autoAssignIClassTeam\s*=\s*new\s+AutoAssignIClassTeamOnTaskUpdate\s*\(/);
  });

  // ── Wired into UpdateTask ────────────────────────────────────────────────────

  it('new UpdateTask(...) includes autoAssignIClassTeam as an effective argument (not only in a comment)', () => {
    // Capture everything between `new UpdateTask(` and the closing `);`
    // The block spans multiple lines so we use [\s\S]*?
    const match = appSrc.match(/new UpdateTask\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    const args = match![1];
    // Strip single-line comments from the args block so a commented-out arg doesn't
    // fool the guard (e.g. `// autoAssignIClassTeam REMOVED` would be a false pass).
    const argsWithoutComments = args.replace(/\/\/[^\n]*/g, '');
    // If this arg is removed, the feature is silently disabled — this is the guard.
    expect(argsWithoutComments).toContain('autoAssignIClassTeam');
  });
});
