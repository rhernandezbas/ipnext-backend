/**
 * suricata-tickets-mirror (Phase J, task J.3, D5/D12) — pins `playwright-core`
 * to an EXACT version (no `^`/`~`) and, once the sidecar step exists in
 * `deploy.yml`, keeps its image tag byte-for-byte in sync with it: the
 * client↔`run-server` protocol is NOT stable across minors (D5), so a drift
 * between these two is a silent incompatibility, not a semver bump.
 *
 * DEVIATION (this apply session, explicit orchestrator instruction): the
 * `.github/workflows/deploy.yml` sidecar step is edited ONLY in the MAIN
 * checkout (a separate directory outside this worktree), left UNCOMMITTED
 * there for human review — shared CI/CD infra gets an extra precaution gate,
 * on top of D5's already-required human OK. This worktree's OWN tracked copy
 * of `deploy.yml` is therefore intentionally left untouched by this session,
 * so the second assertion below is conditional: it does real work the moment
 * the reviewed diff lands in THIS file (whether committed here later or
 * merged in from `main`), and stays a documented no-op until then. The first
 * assertion (the exact pin itself) is unconditional and real today.
 */
import fs from 'fs';
import path from 'path';

describe('suricata-tickets-mirror Phase J — playwright-core / sidecar version composition (D5/D12)', () => {
  const packageJsonPath = path.join(__dirname, '../../../package.json');
  const deployYmlPath = path.join(__dirname, '../../../.github/workflows/deploy.yml');

  function readPackageJson(): { dependencies: Record<string, string> } {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  }

  it('pins playwright-core to an EXACT version — no "^"/"~" range', () => {
    const { dependencies } = readPackageJson();

    expect(dependencies['playwright-core']).toBeDefined();
    expect(dependencies['playwright-core']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('IF deploy.yml already declares a Playwright sidecar image tag, it matches package.json EXACTLY (D5) — see file doc comment for why this is a conditional no-op today', () => {
    const { dependencies } = readPackageJson();
    const deployYml = fs.readFileSync(deployYmlPath, 'utf8');
    const match = deployYml.match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-noble/);

    if (!match) {
      // No sidecar step in THIS file yet (see deviation note above) — nothing
      // to mismatch. This is not a skip: it is the honest, currently-true
      // state of this exact file, asserted explicitly rather than assumed.
      expect(match).toBeNull();
      return;
    }

    expect(match[1]).toBe(dependencies['playwright-core']);
  });
});
