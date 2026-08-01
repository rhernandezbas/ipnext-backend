/**
 * fix/auth-stateful-routers — closes the door on the bug for FUTURE routers.
 *
 * The bug: `createAuthMiddleware(authProvider, sessionRepo?)` silently degrades to a
 * legacy STATELESS JWT-only check when called with a single argument. Nothing at the
 * type level forced callers to pass `sessionRepo` (it's optional, for good reason —
 * a handful of call sites, like `authMiddleware.test.ts`'s own unit tests, legitimately
 * exercise the legacy mode on purpose). ~36 router factories under
 * `src/infrastructure/http/routes/` called it with ONE argument by omission, not by
 * intent, and a REVOKED staff session kept authenticating on those routers until the
 * JWT expired (up to 8h).
 *
 * We chose a composition-root ARCHITECTURE TEST over making `sessionRepo` a mandatory
 * parameter on `createAuthMiddleware` itself: the mandatory-param route would have
 * rippled into every test file that legitimately builds a throwaway stateless auth
 * fixture for something UNRELATED to session semantics (alerts thresholds, access
 * points, etc.), forcing an explicit `createLegacyStatelessAuthMiddleware`-style call
 * there too, for no security benefit (those are test fixtures, not production routes).
 * A test that scans the actual attack surface — `src/infrastructure/http/routes/`,
 * the ONLY place production HTTP traffic enters — gives the same "impossible to add
 * by accident" guarantee with a much smaller blast radius: CI goes red, and the
 * failure message NAMES the offending router file.
 *
 * Companion coverage: `statefulAuthRoutes.revokedSession.test.ts` (behavioural, all 36
 * migrated routers) and `statefulAuthRoutes.appMounts.test.ts` (source-pins that
 * app.ts actually supplies the real `sessionRepo`, not `undefined`).
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROUTES_DIR = join(__dirname, '..', '..', 'infrastructure', 'http', 'routes');

/**
 * Files that intentionally do NOT go through `createAuthMiddleware(authProvider, sessionRepo)`
 * at all, with the reason documented. Adding a file here is a code-review flag, not a
 * silent bypass — the reason has to hold up.
 *
 * Currently EMPTY: every route file that calls `createAuthMiddleware(` now passes both
 * arguments. `profile.routes.ts` is the one file in this directory that skips the
 * stateful helper entirely — it doesn't need an allowlist entry because the scanner
 * below only inspects `createAuthMiddleware(` call sites, and `profile.routes.ts` has
 * none (it uses a separate, pre-existing legacy mock at `../middleware/auth.middleware`
 * — see the dedicated assertion in the second `describe` block, which documents that
 * choice explicitly rather than leaving it as a silent gap).
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * Returns every `createAuthMiddleware(...)` call's raw argument text found in `src`.
 * Argument lists in this codebase are always simple identifiers / property accesses
 * (e.g. `authProvider`, `deps.authProvider`, `sessionRepo`) — never nested calls — so
 * matching non-greedily up to the first `)` correctly captures the whole arg list even
 * when it spans multiple lines.
 */
/**
 * Strips `/* ... *\/` block comments and `// ...` line comments before scanning.
 * Without this, a docstring that MENTIONS the pattern in prose — e.g.
 * `alerts.routes.ts`'s "Session auth (\`createAuthMiddleware(...)\`) applied to..."
 * or `gigared.routes.ts`'s "Mount: app.use('/api/gigared', createAuthMiddleware(...), router)"
 * — reads as a literal single-argument call (`createAuthMiddleware(...)`, dots and
 * all) and false-positives as the exact bug this test exists to catch. This is a
 * crude stripper (doesn't understand strings containing `//` or `/*`), which is fine
 * here: it only needs to be safe enough for this codebase's actual route files, not
 * general-purpose.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function findAuthMiddlewareCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /createAuthMiddleware\(([\s\S]*?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    calls.push(m[1]);
  }
  return calls;
}

/** A call is "stateless" (the bug) if its argument list has no top-level comma. */
function isStatelessCall(argsText: string): boolean {
  return !argsText.includes(',');
}

describe('fix/auth-stateful-routers — architecture guard: no router builds stateless auth by accident', () => {
  const routeFiles = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'));

  it('scanned at least the ~106 known route files (sanity check the scanner itself runs)', () => {
    expect(routeFiles.length).toBeGreaterThan(100);
  });

  it.each(routeFiles.map((f) => [f] as const))('%s: every createAuthMiddleware(...) call passes sessionRepo', (file) => {
    const src = stripComments(readFileSync(join(ROUTES_DIR, file), 'utf8'));
    const calls = findAuthMiddlewareCalls(src);
    const statelessCalls = calls.filter(isStatelessCall);

    if (statelessCalls.length > 0 && ALLOWLIST[file]) {
      // Explicitly excused — the reason is documented in ALLOWLIST above.
      return;
    }

    expect({
      file,
      statelessCalls,
    }).toEqual({ file, statelessCalls: [] });
  });
});

describe('fix/auth-stateful-routers — profile.routes.ts is a KNOWN, DOCUMENTED exception', () => {
  it('profile.routes.ts does not use createAuthMiddleware at all (separate legacy mock, tracked as its own debt)', () => {
    const src = readFileSync(join(ROUTES_DIR, 'profile.routes.ts'), 'utf8');
    expect(src).not.toMatch(/createAuthMiddleware/);
    // Confirms WHAT it uses instead, so a future refactor that silently switches this
    // file onto a stateless createAuthMiddleware call gets caught by the scanner above
    // (it would then have a call site with no sessionRepo, and no allowlist entry).
    expect(src).toMatch(/from '\.\.\/middleware\/auth\.middleware'/);
  });
});
