/**
 * wave-1a (cierre atómico first-writer-wins) — architecture guard.
 *
 * The whole wave rests on ONE invariant: every writer that closes a task goes through
 * `closeTaskIfOpen` (via `applyTaskClosure`), never a bare
 * `updateTask(id, { generalStatus: 'closed' })` and never a bare
 * `prisma.scheduledTask.update({ data: { generalStatus: 'closed' } })`. Those are exactly
 * the TOCTOU bug the wave fixes (read → decide in memory → write, no WHERE guard). A
 * future writer that "forgets" would silently reopen the whole race, and no runtime test
 * would notice — hence a scan of the actual production source.
 *
 * ── FIX WAVE / FIX-7 — what the first version of this guard MISSED ──────────────────
 *  (a) It only looked for `generalStatus: 'closed'`. The legacy compat path
 *      `updateTask(id, { isClosed: true })` closes the task just as hard (both adapters
 *      fold isClosed into generalStatus) and sailed straight through.
 *  (b) Its call-argument regex was `\.updateTask\(([\s\S]*?)\)(?=\s*[;,)])` — it stopped
 *      at the FIRST `)` followed by `;`/`,`/`)`. Any nested call in the arguments
 *      (`updateTask(id, { completedAt: iso(now()) , generalStatus: 'closed' })`) truncated
 *      the captured text BEFORE the offending key, and a call not followed by one of
 *      those three characters was not captured at all. Replaced by a real
 *      balanced-delimiter scanner that also skips string/template literals.
 *  (c) It never looked at DIRECT Prisma writes. `updateTask` is not the only door:
 *      `prisma.scheduledTask.update(...)` bypasses the port entirely. Three such call
 *      sites exist today (app.ts, PrismaFiberAutoProvisionTaskRepository,
 *      bootstrapAutoProvisionFiber) — all three write ONLY `description`, and they pass
 *      BY CONTENT, not by being named in an allowlist. The day one of them adds a
 *      status write, it fails.
 *  (d) `ALLOWED_FILES` was DEAD: it exempted the two adapters from the `.updateTask(`
 *      scan, but neither adapter calls `.updateTask(` at all. It is now a REAL allowlist
 *      for the scan that actually reaches them (the closed-literal scan), and a positive
 *      assertion proves each allowlisted file still contains the guarded write — an
 *      allowlist that stops protecting anything is worse than none.
 *
 * Comments are stripped before matching (molde: statefulAuthRoutes.architecture.test.ts)
 * — a docstring that MENTIONS the old pattern in prose must not false-positive.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_DIR = join(__dirname, '..', '..');

/**
 * The ONLY production files allowed to write `generalStatus: 'closed'` / `isClosed: true`
 * as literals: they ARE the atomic guard's implementation (`closeTaskIfOpen`), one per
 * adapter of the port. Everyone else must go through it.
 */
const CLOSURE_IMPLEMENTORS = [
  join('infrastructure', 'adapters', 'prisma', 'PrismaSchedulingRepository.ts'),
  join('infrastructure', 'adapters', 'in-memory', 'InMemorySchedulingRepository.ts'),
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Extract the FULL argument text of every call to `<token>(`, balancing (), {} and []
 * and skipping ' " ` string literals. Unlike a non-greedy regex this never truncates on
 * a nested call and never needs a lookahead for what follows the closing paren.
 */
export function extractCallArgs(src: string, token: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const hit = src.indexOf(token, from);
    if (hit === -1) break;
    let i = hit + token.length; // just past the '('
    const start = i;
    let depth = 1;
    let quote: string | null = null;
    while (i < src.length && depth > 0) {
      const ch = src[i]!;
      if (quote) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(' || ch === '{' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
      }
      i++;
    }
    // depth===0 → i is one past the matching ')'. Unbalanced (truncated file) → skip.
    if (depth === 0) out.push(src.slice(start, i - 1));
    from = hit + token.length;
  }
  return out;
}

/** Does this argument text close the task — by either of the two equivalent doors? */
export function closesTheTask(callArgs: string): boolean {
  return /generalStatus\s*:\s*['"]closed['"]/.test(callArgs) || /isClosed\s*:\s*true\b/.test(callArgs);
}

/** Does this argument text touch the lifecycle status AT ALL (any value)? */
export function touchesStatus(callArgs: string): boolean {
  return /\bgeneralStatus\s*:/.test(callArgs) || /\bisClosed\s*:/.test(callArgs);
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

const ALL_FILES = walkTsFiles(SRC_DIR);

describe('wave-1a — architecture guard: no updateTask(...) call closes the task', () => {
  const candidates = ALL_FILES.filter(f => readFileSync(f, 'utf8').includes('.updateTask('));

  it('scanned at least the known production source tree (sanity check the walker itself runs)', () => {
    expect(ALL_FILES.length).toBeGreaterThan(500);
  });

  it('found at least one .updateTask( call site (sanity check the pre-filter is not vacuous)', () => {
    expect(candidates.length).toBeGreaterThan(0);
  });

  it.each(candidates.map(f => [f] as const))(
    "%s: no updateTask(...) call sets generalStatus='closed' NOR isClosed:true",
    (file) => {
      const relPath = relative(SRC_DIR, file);
      const calls = extractCallArgs(stripComments(readFileSync(file, 'utf8')), '.updateTask(');
      const offending = calls.filter(closesTheTask);
      expect({ file: relPath, offending }).toEqual({ file: relPath, offending: [] });
    },
  );
});

describe('wave-1a — architecture guard: no DIRECT Prisma write touches the lifecycle status', () => {
  // `updateTask` is not the only door — `prisma.scheduledTask.update(...)` skips the port
  // entirely. Judged BY CONTENT: the three existing call sites write only `description`,
  // so they pass on their merits, not because they are named somewhere.
  const TOKENS = ['scheduledTask.update(', 'scheduledTask.updateMany(', 'scheduledTask.upsert('];
  const candidates = ALL_FILES.filter(f => {
    const raw = readFileSync(f, 'utf8');
    return TOKENS.some(t => raw.includes(t));
  });

  it('found the direct-Prisma call sites (the scan is not vacuous)', () => {
    expect(candidates.length).toBeGreaterThan(0);
  });

  it.each(candidates.map(f => [f] as const))(
    '%s: no direct scheduledTask write sets generalStatus/isClosed outside the port implementation',
    (file) => {
      const relPath = relative(SRC_DIR, file);
      const src = stripComments(readFileSync(file, 'utf8'));
      const calls = TOKENS.flatMap(t => extractCallArgs(src, t));
      const offending = calls.filter(touchesStatus);
      // The adapter that IMPLEMENTS closeTaskIfOpen must write them — that IS the guard.
      if (CLOSURE_IMPLEMENTORS.includes(relPath)) {
        expect(offending.length).toBeGreaterThan(0); // and it had better still do it
        return;
      }
      expect({ file: relPath, offending }).toEqual({ file: relPath, offending: [] });
    },
  );
});

describe('wave-1a — architecture guard: the closed literal lives ONLY in the two port adapters', () => {
  const offenders = ALL_FILES.filter(f => closesTheTask(stripComments(readFileSync(f, 'utf8'))))
    .map(f => relative(SRC_DIR, f))
    .sort();

  it('exactly the two adapters of SchedulingRepository, no third file', () => {
    expect(offenders).toEqual([...CLOSURE_IMPLEMENTORS].sort());
  });

  // FIX-7(d) — an allowlist that protects nothing is worse than no allowlist. Both
  // entries must still CONTAIN the guarded write, otherwise the exemption is stale.
  it.each(CLOSURE_IMPLEMENTORS)('%s still contains the closure write it is exempted for', (relPath) => {
    const src = stripComments(readFileSync(join(SRC_DIR, relPath), 'utf8'));
    expect(closesTheTask(src)).toBe(true);
    expect(src).toContain('closeTaskIfOpen');
  });
});

// ── FIX-7(e) — self-tests, one per pattern. A scanner that never matches anything,
// even synthetically, proves nothing (memoria: "tests que nunca se ejecutan").
describe('wave-1a — self-tests: every detector is discriminating', () => {
  it('flags the classic bug pattern: updateTask with generalStatus closed', () => {
    const bad = stripComments(`
      // some comment mentioning updateTask(...) in prose must NOT match
      async function closeIt() { await this.repo.updateTask(id, { generalStatus: 'closed' }); }
    `);
    expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('FIX-7(a): flags the LEGACY door — updateTask with isClosed: true', () => {
    const bad = stripComments(`await this.repo.updateTask(id, { isClosed: true });`);
    expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('FIX-7(b): flags a call with NESTED parens before the offending key (the old regex truncated here)', () => {
    const bad = stripComments(
      `await repo.updateTask(id, { completedAt: toIso(now()), generalStatus: 'closed' });`,
    );
    const calls = extractCallArgs(bad, '.updateTask(');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("generalStatus: 'closed'");
    expect(calls.some(closesTheTask)).toBe(true);
  });

  it('FIX-7(b): flags a call NOT followed by ; , or ) — the old lookahead skipped it entirely', () => {
    const bad = stripComments(`const t = await repo.updateTask(id, { isClosed: true })\nreturn t;`);
    expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('FIX-7(b): a closing paren INSIDE a string literal does not end the call', () => {
    const bad = stripComments(
      `await repo.updateTask(id, { notes: 'cerrada (por el cron)', generalStatus: 'closed' });`,
    );
    expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('FIX-7(c): flags a DIRECT prisma write that closes the task', () => {
    const bad = stripComments(
      `await prisma.scheduledTask.update({ where: { id }, data: { generalStatus: 'closed', isClosed: true } });`,
    );
    expect(extractCallArgs(bad, 'scheduledTask.update(').some(touchesStatus)).toBe(true);
  });

  it('FIX-7(c): a DIRECT prisma write of only `description` is NOT flagged (the three real call sites)', () => {
    const good = stripComments(
      `await prisma.scheduledTask.update({ where: { id: taskId }, data: { description } });`,
    );
    expect(extractCallArgs(good, 'scheduledTask.update(').some(touchesStatus)).toBe(false);
  });

  it('a variable-based status (the actual fixed code) is NOT flagged', () => {
    const good = stripComments(`await this.repo.updateTask(id, { generalStatus: status });`);
    expect(extractCallArgs(good, '.updateTask(').some(closesTheTask)).toBe(false);
  });

  it('isClosed: false (a REOPEN) is not a closure and is NOT flagged', () => {
    const good = stripComments(`await this.repo.updateTask(id, { isClosed: false });`);
    expect(extractCallArgs(good, '.updateTask(').some(closesTheTask)).toBe(false);
  });

  it('comment stripping: the bug pattern written ONLY in a comment is invisible to every detector', () => {
    const commented = stripComments(`
      /* await repo.updateTask(id, { generalStatus: 'closed' }); */
      // await repo.updateTask(id, { isClosed: true });
      export const x = 1;
    `);
    expect(extractCallArgs(commented, '.updateTask(')).toHaveLength(0);
    expect(closesTheTask(commented)).toBe(false);
  });
});
