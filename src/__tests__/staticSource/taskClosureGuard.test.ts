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
import { stripComments, extractCallArgs, methodBody } from '../helpers/staticSourceScan';

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

/** Does this argument text close the task — by either of the two equivalent doors? */
export function closesTheTask(callArgs: string): boolean {
  return /generalStatus\s*:\s*['"]closed['"]/.test(callArgs) || /isClosed\s*:\s*true\b/.test(callArgs);
}

/** Does this argument text touch the lifecycle status AT ALL (any value)? */
export function touchesStatus(callArgs: string): boolean {
  return /\bgeneralStatus\s*:/.test(callArgs) || /\bisClosed\s*:/.test(callArgs);
}

/** The two literal spellings of "this write closes the task", as COUNTABLE patterns. */
const CLOSURE_WRITES = {
  "generalStatus: 'closed'": /generalStatus\s*:\s*['"]closed['"]/g,
  'isClosed: true': /isClosed\s*:\s*true\b/g,
} as const;

export type ClosureWriteCounts = Record<keyof typeof CLOSURE_WRITES, number>;

/** How many times each closure literal occurs in `src`. */
export function countClosureWrites(src: string): ClosureWriteCounts {
  const out = {} as ClosureWriteCounts;
  for (const [label, re] of Object.entries(CLOSURE_WRITES)) {
    out[label as keyof ClosureWriteCounts] = (src.match(new RegExp(re.source, 'g')) ?? []).length;
  }
  return out;
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

/**
 * ── FIX-E (fix wave 2) — la exención es POR LLAMADA, no por ARCHIVO ────────────────
 *
 * `CLOSURE_IMPLEMENTORS` eximía a los dos adapters ENTEROS: cualquier SEGUNDA escritura
 * de `generalStatus: 'closed'` dentro de esos archivos — un método nuevo que cierre sin
 * el `WHERE` guardado, un helper "de conveniencia" — pasaba en verde. Justo los dos
 * archivos donde más barato es equivocarse, porque son los únicos autorizados a escribir
 * el literal.
 *
 * Se endurece con DOS pines, cada uno suficiente por su cuenta:
 *  1. CONTEO EXACTO por archivo y por literal (una ocurrencia de cada uno, hoy).
 *  2. CONTENCIÓN: TODAS las ocurrencias viven dentro del cuerpo de `closeTaskIfOpen`.
 * El (2) además caza el movimiento: sacar la escritura del guard a otro método mantiene
 * el conteo pero rompe la contención. Y los dos juntos son el canario de desincronización
 * del stripper (FIX-F): si se empieza a comer el cuerpo del adapter, el conteo cae a 0.
 */
const ALLOWED_CLOSURE_WRITES: Record<string, ClosureWriteCounts> = {
  [CLOSURE_IMPLEMENTORS[0]!]: { "generalStatus: 'closed'": 1, 'isClosed: true': 1 },
  [CLOSURE_IMPLEMENTORS[1]!]: { "generalStatus: 'closed'": 1, 'isClosed: true': 1 },
};

/**
 * FIX-δ (fix wave 3) — jest no acepta un mensaje en `expect`, así que la GUÍA de qué
 * hacer cuando el pin se pone rojo se adjunta al error. Sin esto, el fallo se lee como
 * "un número no coincide" y el arreglo obvio (y equivocado) es subir el número.
 */
function withGuidance(guidance: string, assertion: () => void): void {
  try {
    assertion();
  } catch (e) {
    const err = e as Error;
    err.message = `${err.message}\n\n──────── QUÉ SIGNIFICA ESTE ROJO ────────\n${guidance}\n`;
    throw err;
  }
}

const PIN_GUIDANCE = [
  'NO subas el número para poner el test en verde.',
  '',
  'Una escritura de cierre NUEVA en un adapter significa que hay un camino que cierra',
  'tareas SIN pasar por closeTaskIfOpen — que es exactamente la race (read → decide en',
  'memoria → write, sin WHERE guardado) que arregla la wave-1a. Revisá, en este orden:',
  '',
  '  1. ¿La escritura nueva está FUERA de closeTaskIfOpen? Entonces es el bug: rutéala',
  '     por applyTaskClosure() → repo.closeTaskIfOpen(), como hacen los 5 escritores.',
  '  2. ¿Es un helper "de conveniencia" dentro del mismo archivo? Mismo caso: el literal',
  '     sólo puede vivir dentro del cuerpo del guard.',
  '  3. ¿El guard cambió de FORMA a propósito (p.ej. dos updateMany en vez de uno)?',
  '     Recién ahí se actualiza ALLOWED_CLOSURE_WRITES, en el MISMO commit, con el',
  '     porqué escrito al lado.',
  '',
  'Y si el conteo cayó a CERO: no desapareció el guard, se desincronizó el stripper',
  '(staticSourceScan.stripComments) y se está comiendo el cuerpo del adapter. Ver FIX-F.',
].join('\n');

describe('wave-1a — FIX-E: en los adapters allowlisted la escritura de cierre está PINEADA', () => {
  it.each(CLOSURE_IMPLEMENTORS)('%s: conteo EXACTO de literales de cierre (una segunda escritura rompe el test)', (relPath) => {
    const src = stripComments(readFileSync(join(SRC_DIR, relPath), 'utf8'));
    withGuidance(PIN_GUIDANCE, () => {
      expect({ file: relPath, ...countClosureWrites(src) }).toEqual({
        file: relPath,
        ...ALLOWED_CLOSURE_WRITES[relPath]!,
      });
    });
  });

  it.each(CLOSURE_IMPLEMENTORS)('%s: TODA ocurrencia vive dentro del cuerpo de closeTaskIfOpen', (relPath) => {
    const src = stripComments(readFileSync(join(SRC_DIR, relPath), 'utf8'));
    const body = methodBody(src, 'closeTaskIfOpen');
    expect(body).not.toBeNull(); // presencia antes que ausencia: el método existe y se pudo aislar
    const inBody = countClosureWrites(body!);
    withGuidance(PIN_GUIDANCE, () => {
      // Si el cuerpo tiene MENOS que el archivo, hay una escritura de cierre AFUERA del guard.
      expect({ file: relPath, ...inBody }).toEqual({ file: relPath, ...countClosureWrites(src) });
      // Y el cuerpo aislado tiene que traer las escrituras de verdad (no un {} vacío).
      expect(inBody["generalStatus: 'closed'"]).toBeGreaterThan(0);
      expect(inBody['isClosed: true']).toBeGreaterThan(0);
    });
  });

  it('FIX-δ self-test: cuando el pin falla, el error TRAE la guía (si no, nadie la lee)', () => {
    expect(() => withGuidance(PIN_GUIDANCE, () => expect(2).toBe(1))).toThrow(/NO subas el número/);
    // Y cuando pasa, no se inventa nada.
    expect(() => withGuidance(PIN_GUIDANCE, () => expect(1).toBe(1))).not.toThrow();
  });
});

describe('wave-1a — FIX-E self-tests: el pin discrimina de verdad', () => {
  const ADAPTER_SHAPE = `
    export class X {
      async closeTaskIfOpen(id: string, input: CloseTaskIfOpenInput): Promise<CloseTaskResult> {
        const { count } = await tx.scheduledTask.updateMany({
          where: { id, generalStatus: { not: 'closed' } },
          data: { generalStatus: 'closed', isClosed: true },
        });
        return { closed: count === 1 };
      }
    }
  `;

  it('la forma legítima pasa: un literal de cada uno, ambos dentro de closeTaskIfOpen', () => {
    const src = stripComments(ADAPTER_SHAPE);
    expect(countClosureWrites(src)).toEqual({ "generalStatus: 'closed'": 1, 'isClosed: true': 1 });
    expect(countClosureWrites(methodBody(src, 'closeTaskIfOpen')!)).toEqual(countClosureWrites(src));
  });

  it('una SEGUNDA escritura en OTRO método del mismo archivo rompe el conteo Y la contención', () => {
    const src = stripComments(
      ADAPTER_SHAPE.replace(
        '    }\n  ',
        `    }
      async closeItTheEasyWay(id: string): Promise<void> {
        await prisma.scheduledTask.update({ where: { id }, data: { generalStatus: 'closed', isClosed: true } });
      }
    `,
      ),
    );
    // (1) el conteo se va a 2 — el pin de 1 falla
    expect(countClosureWrites(src)["generalStatus: 'closed'"]).toBe(2);
    // (2) y la contención también: el cuerpo del guard sigue teniendo 1
    expect(countClosureWrites(methodBody(src, 'closeTaskIfOpen')!)["generalStatus: 'closed'"]).toBe(1);
  });

  it('MOVER la escritura fuera del guard mantiene el conteo pero rompe la contención', () => {
    const moved = stripComments(`
      export class X {
        async closeTaskIfOpen(id: string): Promise<CloseTaskResult> {
          return this.writeIt(id);
        }
        async writeIt(id: string): Promise<CloseTaskResult> {
          await prisma.scheduledTask.update({ where: { id }, data: { generalStatus: 'closed', isClosed: true } });
          return { closed: true };
        }
      }
    `);
    expect(countClosureWrites(moved)).toEqual({ "generalStatus: 'closed'": 1, 'isClosed: true': 1 }); // conteo intacto
    expect(countClosureWrites(methodBody(moved, 'closeTaskIfOpen')!)).toEqual({
      "generalStatus: 'closed'": 0,
      'isClosed: true': 0,
    }); // contención rota
  });

  it('methodBody aísla el método correcto (no se lleva el resto de la clase)', () => {
    const body = methodBody(stripComments(ADAPTER_SHAPE), 'closeTaskIfOpen');
    expect(body).toContain('updateMany');
    expect(body).not.toContain('export class');
    expect(body!.startsWith('{')).toBe(true);
    expect(body!.endsWith('}')).toBe(true);
  });

  it('methodBody devuelve null cuando el método no existe (no inventa un cuerpo)', () => {
    expect(methodBody('export class X { async other() { return 1; } }', 'closeTaskIfOpen')).toBeNull();
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

  // ── FIX-F (fix wave 2) — el stripper tiene que ser CONSCIENTE DE STRINGS ─────────
  it('FIX-F: una URL en un string NO abre un comentario de línea — la escritura que la SIGUE se caza', () => {
    // `//` dentro de un string literal no abre un comentario. El stripper viejo
    // (`/\/\/.*$/gm` sobre texto crudo) borraba desde `//wiki…` hasta el fin de la
    // línea — y con eso se llevaba puesta la violación que venía después. Falso
    // negativo SILENCIOSO: el guard daba verde sobre código que cierra a mano.
    const bad = stripComments(
      `const doc = 'https://wiki.interno/cierres'; await repo.updateTask(id, { generalStatus: 'closed' });`,
    );
    expect(bad).toContain('updateTask('); // presencia antes que ausencia: no se comió la línea
    expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('FIX-F: una URL con `/*` en un string no abre un comentario de BLOQUE (se comía líneas enteras)', () => {
    const bad = stripComments(
      [
        `const glob = 'https://cdn.interno/assets/*';`,
        `await repo.updateTask(id, { generalStatus: 'closed' });`,
        `const x = 1; /* un comentario de verdad */`,
      ].join('\n'),
    );
    expect(bad).toContain('updateTask(');
    expect(bad).not.toContain('un comentario de verdad');
    expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('FIX-F: la URL sigue viva en el stripped (no se borra media línea de código)', () => {
    const stripped = stripComments(`const doc = "http://x/y"; // comentario de verdad\n`);
    expect(stripped).toContain('"http://x/y"');
    expect(stripped).not.toContain('comentario de verdad');
  });

  it('FIX-F: un regex literal con comilla no desincroniza (la comilla NO abre un string)', () => {
    const bad = stripComments(
      [`const q = /['"]/g;`, `await repo.updateTask(id, { isClosed: true });`].join('\n'),
    );
    expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('FIX-F: un `//` dentro de un regex literal tampoco abre un comentario', () => {
    const bad = stripComments(
      [`const slash = /\\/\\//g;`, `await repo.updateTask(id, { generalStatus: 'closed' });`].join('\n'),
    );
    expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  // ── MEDIUM-2 (fix wave 3) — el `/` de un regex literal en posición de KEYWORD ─────
  //
  // `canPrecedeRegex` sólo miraba el ÚLTIMO CARÁCTER significativo (`([{,;:=!&|?+-*%~^<>`).
  // Después de `return`, `await`, `typeof`, `case`… el carácter previo es una LETRA, así
  // que un `/` ahí se tomaba como división y el regex quedaba sin tokenizar. Con un regex
  // que contiene `\/` — el caso más común de todos, matchear una URL — los dos últimos
  // caracteres del literal son `//`, y el stripper los leía como apertura de comentario:
  // borraba desde ahí hasta el fin de la línea, LLEVÁNDOSE UNA VIOLACIÓN QUE VIVIERA EN
  // LA MISMA LÍNEA. Falso negativo silencioso, igual que FIX-F.
  const REGEX_KEYWORDS = [
    'return', 'typeof', 'case', 'in', 'of', 'void',
    'delete', 'do', 'else', 'instanceof', 'new', 'throw', 'yield', 'await',
  ] as const;

  it.each(REGEX_KEYWORDS)(
    'MEDIUM-2: un regex terminado en \\/ después de `%s` no se come el resto de la línea',
    (kw) => {
      const bad = stripComments(
        `${kw} /https:\\/\\//.test(u); await repo.updateTask(id, { generalStatus: 'closed' })`,
      );
      expect(bad).toContain('updateTask('); // presencia antes que ausencia: la línea sobrevivió
      expect(extractCallArgs(bad, '.updateTask(').some(closesTheTask)).toBe(true);
    },
  );

  it('MEDIUM-2: `)` antes de `/` SIGUE siendo división (no se rompe `(a + b) / c`)', () => {
    const src = stripComments(
      `const r = (a + b) / c; // un comentario de verdad\nawait repo.updateTask(id, { generalStatus: 'closed' });`,
    );
    expect(src).toContain('(a + b) / c'); // la división quedó intacta
    expect(src).not.toContain('un comentario de verdad'); // y el comentario SÍ se borró
    expect(extractCallArgs(src, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('MEDIUM-2: un identificador que TERMINA en keyword no habilita el modo regex (`myreturn / 2`)', () => {
    const src = stripComments(
      `const q = myreturn / 2; // un comentario de verdad\nawait repo.updateTask(id, { isClosed: true });`,
    );
    expect(src).toContain('myreturn / 2');
    expect(src).not.toContain('un comentario de verdad');
    expect(extractCallArgs(src, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('MEDIUM-2: una PROPIEDAD llamada como una keyword tampoco (`cfg.in / 2`)', () => {
    const src = stripComments(
      `const q = cfg.in / 2; // un comentario de verdad\nawait repo.updateTask(id, { isClosed: true });`,
    );
    expect(src).toContain('cfg.in / 2');
    expect(src).not.toContain('un comentario de verdad');
    expect(extractCallArgs(src, '.updateTask(').some(closesTheTask)).toBe(true);
  });

  it('MEDIUM-2: el regex tras keyword se copia ENTERO al stripped (no se parte a la mitad)', () => {
    const stripped = stripComments(`const ok = () => { return /a\\/b/.test(x); }; // fuera`);
    expect(stripped).toContain('/a\\/b/');
    expect(stripped).not.toContain('fuera');
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
