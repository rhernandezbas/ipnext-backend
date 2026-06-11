/**
 * #40 — composition-root (W6) static guard.
 *
 * Booting createApp() needs a live DB, so this asserts the wiring statically by
 * reading app.ts source (same pattern as inventory-composition-root.test.ts):
 *
 *  1) createProjectsRouter(...) is called with requirePerm('scheduling','manage')
 *     as the 9th arg (gates the isNetworkProject mutation).
 *  2) new CreateTask(...) wires prismaProjectKindLookup as the project-lookup slot,
 *     and that helper's select includes isNetworkProject: true (single-query guard).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Projects network-flag composition root (#40)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  it('app.ts passes requirePerm(scheduling, manage) into createProjectsRouter', () => {
    const callIdx = appSrc.indexOf('createProjectsRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    const callWindow = appSrc.slice(callIdx, callIdx + 400);
    expect(callWindow).toMatch(/requirePerm\s*\(\s*['"]scheduling['"]\s*,\s*['"]manage['"]\s*\)/);
  });

  it('app.ts wires prismaProjectKindLookup into the new CreateTask( block', () => {
    const match = appSrc.match(/new CreateTask\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('prismaProjectKindLookup');
  });

  it('app.ts wires prismaProjectKindLookup into the new UpdateTask( block (#40 guard on update)', () => {
    const match = appSrc.match(/new UpdateTask\(([\s\S]*?)\)\s*;/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('prismaProjectKindLookup');
  });

  it('prismaProjectKindLookup select includes isNetworkProject: true', () => {
    // The lookup helper must request isNetworkProject so the guard runs from one query.
    const defIdx = appSrc.indexOf('prismaProjectKindLookup');
    expect(defIdx).toBeGreaterThan(-1);
    // Find the helper definition (first occurrence is the definition).
    const defWindow = appSrc.slice(defIdx, defIdx + 300);
    expect(defWindow).toMatch(/isNetworkProject:\s*true/);
  });
});
