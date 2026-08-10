/**
 * wave-1a (cierre atómico first-writer-wins) — architecture guard.
 *
 * The whole wave rests on ONE invariant: every writer that closes a task goes
 * through `closeTaskIfOpen` (via `applyTaskClosure`), never a bare
 * `updateTask(id, { generalStatus: 'closed' })`. That bare call is exactly the
 * TOCTOU bug the wave fixes (getTask → check in memory → updateTask, no WHERE
 * guard) — a future writer that "forgets" and calls updateTask directly would
 * silently reopen the whole race. This scans the actual production source (the
 * only two files ALLOWED to touch `generalStatus: 'closed'` directly are the repo
 * adapters implementing `closeTaskIfOpen` itself) instead of trusting code review
 * to catch a 6th writer years from now.
 *
 * Comments are stripped before matching (molde:
 * statefulAuthRoutes.architecture.test.ts) — a docstring that MENTIONS the old
 * pattern in prose must not false-positive as a literal violation.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_DIR = join(__dirname, '..', '..');

/** The ONLY files allowed to set generalStatus='closed' directly — they ARE the
 * atomic guard's implementation (`closeTaskIfOpen`), everyone else must go through it. */
const ALLOWED_FILES = new Set([
  join('infrastructure', 'adapters', 'prisma', 'PrismaSchedulingRepository.ts'),
  join('infrastructure', 'adapters', 'in-memory', 'InMemorySchedulingRepository.ts'),
]);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Every `.updateTask(...)` call's raw argument text (non-greedy up to the first
 * top-level `)`). Same crude-but-sufficient approach as statefulAuthRoutes'
 * `findAuthMiddlewareCalls`: this codebase's call sites are never deeply nested
 * enough to break a non-greedy match. */
function findUpdateTaskCalls(src: string): string[] {
  const calls: string[] = [];
  const re = /\.updateTask\(([\s\S]*?)\)(?=\s*[;,)])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    calls.push(m[1]);
  }
  return calls;
}

function hasDirectClose(callArgs: string): boolean {
  return /generalStatus\s*:\s*['"]closed['"]/.test(callArgs);
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue; // production source only
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('wave-1a — architecture guard: no updateTask(...) call closes generalStatus directly', () => {
  const allFiles = walkTsFiles(SRC_DIR);
  // Cheap pre-filter on RAW content (before stripping) — keeps the it.each list to
  // only the files that could possibly matter, same spirit as scoping
  // statefulAuthRoutes to its routes directory.
  const candidateFiles = allFiles.filter(f => readFileSync(f, 'utf8').includes('.updateTask('));

  it('scanned at least the known production source tree (sanity check the walker itself runs)', () => {
    expect(allFiles.length).toBeGreaterThan(500);
  });

  it('found at least one .updateTask( call site (sanity check the pre-filter is not vacuous)', () => {
    expect(candidateFiles.length).toBeGreaterThan(0);
  });

  it.each(candidateFiles.map(f => [f] as const))('%s: no updateTask(...) call sets generalStatus=\'closed\' directly', (file) => {
    const relPath = relative(SRC_DIR, file);
    const src = stripComments(readFileSync(file, 'utf8'));
    const calls = findUpdateTaskCalls(src);
    const offending = calls.filter(hasDirectClose);

    if (offending.length > 0 && ALLOWED_FILES.has(relPath)) {
      return; // the atomic guard's own implementation — expected and fine.
    }

    expect({ file: relPath, offending }).toEqual({ file: relPath, offending: [] });
  });

  // Proves the detector is not vacuous (memory: "tests that never execute" — a
  // scanner that never matches anything, even synthetically, proves nothing).
  it('self-test: the detector DOES flag the exact bug pattern when present', () => {
    const bad = stripComments(`
      // some comment mentioning updateTask(...) in prose must NOT match
      async function closeIt() {
        await this.repo.updateTask(id, { generalStatus: 'closed' });
      }
    `);
    const calls = findUpdateTaskCalls(bad);
    expect(calls.some(hasDirectClose)).toBe(true);
  });

  it('self-test: a variable-based status (the actual fixed code) is NOT flagged', () => {
    const good = stripComments(`
      async function closeIt(status) {
        await this.repo.updateTask(id, { generalStatus: status });
      }
    `);
    const calls = findUpdateTaskCalls(good);
    expect(calls.some(hasDirectClose)).toBe(false);
  });
});
