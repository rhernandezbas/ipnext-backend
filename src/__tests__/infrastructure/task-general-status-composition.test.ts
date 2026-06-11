/**
 * #41 — composition-root (W6) static guard.
 *
 * Booting createApp() needs a live DB, so this asserts the wiring statically by
 * reading app.ts source (same pattern as projects-network-flag-composition.test.ts):
 *
 *  1) createSchedulingRouter(...) is called with requirePerm('scheduling','write')
 *     (gates POST /:id/status).
 *  2) new SetTaskGeneralStatus(...) is wired with schedulingRepo + taskActivityRecorder.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Task general-status composition root (#41)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  it("app.ts passes requirePerm('scheduling', 'write') into createSchedulingRouter", () => {
    const callIdx = appSrc.indexOf('createSchedulingRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    // The call spans many lines (checklist object, optional UCs, perms) — keep a
    // generous window so adding args upstream never makes this assertion brittle.
    const callWindow = appSrc.slice(callIdx, callIdx + 1500);
    expect(callWindow).toMatch(/requirePerm\s*\(\s*['"]scheduling['"]\s*,\s*['"]write['"]\s*\)/);
  });

  it('app.ts wires schedulingRepo + taskActivityRecorder into new SetTaskGeneralStatus(', () => {
    const match = appSrc.match(/new SetTaskGeneralStatus\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('schedulingRepo');
    expect(args).toContain('taskActivityRecorder');
  });
});
