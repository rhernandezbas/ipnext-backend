/**
 * Composition-root static source guard for iclass-os-actions (Ola A + Ola B).
 *
 * Reads app.ts as a plain string and asserts that the new use cases, repos, and
 * routes are wired — catching any accidental revert of the wiring without relying
 * on runtime DB connectivity.
 *
 * Pattern: same as task-archive-composition.test.ts and similar guards in this codebase.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('iclass-os-actions composition root (CR1)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  // ── Use cases instantiated ────────────────────────────────────────────────

  it('app.ts imports and instantiates CloseIClassServiceOrder', () => {
    expect(appSrc).toContain("import { CloseIClassServiceOrder }");
    expect(appSrc).toMatch(/new CloseIClassServiceOrder\s*\(/);
  });

  it('app.ts imports and instantiates AssignIClassTeam', () => {
    expect(appSrc).toContain("import { AssignIClassTeam }");
    expect(appSrc).toMatch(/new AssignIClassTeam\s*\(/);
  });

  it('app.ts imports and instantiates SyncIClassTeams', () => {
    expect(appSrc).toContain("import { SyncIClassTeams }");
    expect(appSrc).toMatch(/new SyncIClassTeams\s*\(/);
  });

  it('app.ts imports and instantiates ListIClassTeams', () => {
    expect(appSrc).toContain("import { ListIClassTeams }");
    expect(appSrc).toMatch(/new ListIClassTeams\s*\(/);
  });

  // ── Repository ────────────────────────────────────────────────────────────

  it('app.ts imports and instantiates PrismaIClassTeamRepository', () => {
    expect(appSrc).toContain("import { PrismaIClassTeamRepository }");
    expect(appSrc).toMatch(/new PrismaIClassTeamRepository\s*\(/);
  });

  // ── Action routes wired into createSchedulingRouter ───────────────────────

  it("createSchedulingRouter is called with closeIClassServiceOrder", () => {
    const callIdx = appSrc.indexOf('createSchedulingRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    // Window large enough to cover the full call (the call spans ~400 chars)
    const callWindow = appSrc.slice(callIdx, callIdx + 2000);
    expect(callWindow).toContain('closeIClassServiceOrder');
  });

  it("createSchedulingRouter is called with assignIClassTeam", () => {
    const callIdx = appSrc.indexOf('createSchedulingRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    const callWindow = appSrc.slice(callIdx, callIdx + 2000);
    expect(callWindow).toContain('assignIClassTeam');
  });

  // ── Teams router mounted ──────────────────────────────────────────────────

  it('app.ts imports createIClassTeamsRouter and mounts it under /api/admin/iclass', () => {
    expect(appSrc).toContain("import { createIClassTeamsRouter }");
    // The router must be mounted — look for the mount call
    expect(appSrc).toMatch(/app\.use\s*\(\s*['"]\/api\/admin\/iclass['"]\s*,\s*createIClassTeamsRouter\s*\(/);
  });
});
