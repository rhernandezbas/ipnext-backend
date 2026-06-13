/**
 * #86 — composition-root static guard.
 *
 * Asserts (by reading app.ts source) that:
 *  1) createSchedulingRouter(...) is called with archiveTask wired
 *  2) createSchedulingRouter(...) is called with requirePerm('scheduling','hard_delete')
 *  3) new ArchiveTask(...) is constructed with schedulingRepo
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Task archive composition root (#86)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  it("app.ts passes requirePerm('scheduling', 'hard_delete') into createSchedulingRouter", () => {
    const callIdx = appSrc.indexOf('createSchedulingRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    const callWindow = appSrc.slice(callIdx, callIdx + 1800);
    expect(callWindow).toMatch(/requirePerm\s*\(\s*['"]scheduling['"]\s*,\s*['"]hard_delete['"]\s*\)/);
  });

  it('app.ts passes archiveTask into createSchedulingRouter', () => {
    const callIdx = appSrc.indexOf('createSchedulingRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    const callWindow = appSrc.slice(callIdx, callIdx + 1800);
    expect(callWindow).toContain('archiveTask');
  });

  it('app.ts wires schedulingRepo into new ArchiveTask(', () => {
    const match = appSrc.match(/new ArchiveTask\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('schedulingRepo');
  });
});
