/**
 * TDD — fix wave W1a / FIX-2 — the closure ACTIVITY RECORDER must reach the CRON.
 *
 * `applyTaskClosure` records the `closure_conflict` activity ONLY when a recorder was
 * injected. `app.ts` injects one; the three cron/backfill composition roots did NOT —
 * so the discrepancy the spec demands be "CONSULTABLE, no solo un log que rota" was,
 * in production, only a log line. Every unit test passed because each one injects its
 * OWN `FakeTaskActivityRecorder`: a test that supplies the collaborator can never
 * discover that production forgets to supply it (memory: "la función que decide no es
 * la que se testea" / "premisa verificada en OTRO endpoint").
 *
 * So this test reads the REAL composition-root SOURCE (molde: taskClosureGuard.test.ts).
 * Comments are stripped before matching — a docstring that merely MENTIONS `recorder`
 * must not satisfy the assertion (memory: "tests sobre TEXTO deben filtrar comentarios").
 */
import { readFileSync } from 'fs';
import { join } from 'path';
// FIX-F / FIX-G(b) (fix wave 2) — el scanner es COMPARTIDO con taskClosureGuard: la copia
// local de `stripComments` acá era la versión vieja, ciega a los strings (una URL en un
// literal se comía el resto de la línea). Arreglar la clase, no la instancia.
import { stripComments, extractCallArgs, splitTopLevelArgs, objectLiteralEntries } from '../helpers/staticSourceScan';

const SRC_DIR = join(__dirname, '..', '..');

function readStripped(...parts: string[]): string {
  return stripComments(readFileSync(join(SRC_DIR, ...parts), 'utf8'));
}

const SIDE_EFFECTS = ['infrastructure', 'scheduling', 'closureSideEffects.ts'] as const;

/** The three composition roots that build an IngestClosedServiceOrders for a job. */
const BOOTSTRAPS = [
  ['infrastructure', 'scheduling', 'bootstrapIClassClosure.ts'],
  ['infrastructure', 'scheduling', 'bootstrapTaskAutocomplete.ts'],
  ['infrastructure', 'scheduling', 'bootstrapBackfill.ts'],
] as const;

describe('FIX-2 — buildClosureSideEffects supplies the TaskActivityRecorder', () => {
  const src = readStripped(...SIDE_EFFECTS);

  it('sanity: the file really was read and really builds the side effects', () => {
    expect(src).toContain('export function buildClosureSideEffects');
    expect(src.length).toBeGreaterThan(500);
  });

  it("the SideEffects type includes 'recorder' (so the option is not silently dropped by the Pick)", () => {
    const pick = /Pick<\s*IngestClosedOptions\s*,([\s\S]*?)>/.exec(src);
    expect(pick).not.toBeNull();
    expect(pick![1]).toMatch(/'recorder'/);
  });

  it('it instantiates a REAL DefaultTaskActivityRecorder (not a stub, not undefined)', () => {
    expect(src).toMatch(/recorder\s*:\s*new DefaultTaskActivityRecorder\(/);
    expect(src).toMatch(/new RecordTaskActivity\(/);
    // The recorder must be backed by the PRISMA activity repo — an in-memory one here
    // would write conflicts to a Map that dies with the process.
    expect(src).toMatch(/new PrismaTaskActivityRepository\(\)/);
    expect(src).toMatch(/import\s+\{\s*DefaultTaskActivityRecorder\s*\}/);
  });
});

describe.each(BOOTSTRAPS.map(b => [b[b.length - 1], b] as const))(
  'FIX-2 — %s wires the recorder into IngestClosedServiceOrders',
  (_name, parts) => {
    const src = readStripped(...parts);

    it('sanity: the file really was read and really builds the ingest', () => {
      expect(src).toContain('new IngestClosedServiceOrders(');
    });

    it('spreads buildClosureSideEffects() into the ingest options (so it inherits the recorder)', () => {
      // The options object is the LAST constructor argument; the spread is what carries
      // every collaborator, recorder included. Asserting the spread (rather than a
      // literal `recorder:`) is what keeps the three roots honest through ONE fix.
      expect(src).toMatch(/\{\s*\.\.\.buildClosureSideEffects\(\)/);
      expect(src).toContain("from './closureSideEffects'");
    });

    // ── FIX-G(b) (fix wave 2) — el `toMatch` de arriba es un match de TEXTO SUELTO ────
    // Sólo prueba que en ALGÚN lado del archivo hay un `{ ...buildClosureSideEffects()`.
    // Pasaba igual si el spread estuviera en un objeto que no es el de opciones del
    // constructor, y — peor — si DESPUÉS del spread viniera un `recorder: undefined`
    // (o un segundo spread) que lo pisa: el orden de claves decide, y el regex no lo ve.
    // Acá se parsea la llamada con el mismo parser balanceado del guard.
    it('FIX-G(b): el spread está DENTRO del objeto de opciones del constructor y NADA posterior pisa `recorder`', () => {
      const calls = extractCallArgs(src, 'new IngestClosedServiceOrders(');
      expect(calls).toHaveLength(1); // presencia antes que ausencia: la llamada se parseó

      const args = splitTopLevelArgs(calls[0]!);
      expect(args.length).toBeGreaterThanOrEqual(6); // 5 puertos + el objeto de opciones
      const entries = objectLiteralEntries(args[args.length - 1]!);
      expect(entries).not.toBeNull(); // el ÚLTIMO argumento es un object literal

      const spreadAt = entries!.findIndex(e => /^\.\.\.\s*buildClosureSideEffects\(\s*\)$/.test(e));
      expect(spreadAt).toBeGreaterThanOrEqual(0); // y el spread es una entrada SUYA

      // Todo lo que venga DESPUÉS del spread gana por precedencia de object literal.
      const after = entries!.slice(spreadAt + 1);
      expect(after.filter(e => /^recorder\s*:/.test(e))).toEqual([]);
      expect(after.filter(e => e.trimStart().startsWith('...'))).toEqual([]);
    });
  },
);

describe('FIX-2 — self-tests: the matchers are not vacuous', () => {
  it('a recorder mentioned ONLY in a comment does NOT satisfy the detector', () => {
    const commentOnly = stripComments(`
      // recorder: new DefaultTaskActivityRecorder(new RecordTaskActivity(x))
      export function buildClosureSideEffects() { return {}; }
    `);
    expect(commentOnly).not.toMatch(/recorder\s*:\s*new DefaultTaskActivityRecorder\(/);
  });

  it('a Pick WITHOUT recorder is rejected by the Pick matcher', () => {
    const noRecorder = "type SideEffects = Pick<IngestClosedOptions, 'portal' | 'postComment'>;";
    const pick = /Pick<\s*IngestClosedOptions\s*,([\s\S]*?)>/.exec(noRecorder);
    expect(pick![1]).not.toMatch(/'recorder'/);
  });

  it('a bootstrap that passes a bare options object (no spread) is rejected', () => {
    const noSpread = 'const ingest = new IngestClosedServiceOrders(a, b, c, d, e, { statusCatalog });';
    expect(noSpread).not.toMatch(/\{\s*\.\.\.buildClosureSideEffects\(\)/);
  });

  // ── FIX-G(b) — los tres mutantes que el regex de texto suelto NO distinguía ────────
  const optionsOf = (source: string) => {
    const args = splitTopLevelArgs(extractCallArgs(source, 'new IngestClosedServiceOrders(')[0]!);
    return objectLiteralEntries(args[args.length - 1]!)!;
  };

  it('FIX-G(b): un `recorder: undefined` DESPUÉS del spread pasa el regex viejo y es rechazado por el nuevo', () => {
    const overridden =
      'const i = new IngestClosedServiceOrders(a, b, c, d, e, { ...buildClosureSideEffects(), recorder: undefined });';
    expect(overridden).toMatch(/\{\s*\.\.\.buildClosureSideEffects\(\)/); // ← el viejo daba VERDE

    const entries = optionsOf(overridden);
    const spreadAt = entries.findIndex(e => /^\.\.\.\s*buildClosureSideEffects\(\s*\)$/.test(e));
    expect(entries.slice(spreadAt + 1).filter(e => /^recorder\s*:/.test(e))).toEqual(['recorder: undefined']);
  });

  it('FIX-G(b): un SEGUNDO spread posterior también puede pisar el recorder y es detectado', () => {
    const shadowed =
      'const i = new IngestClosedServiceOrders(a, b, c, d, e, { ...buildClosureSideEffects(), ...overrides });';
    const entries = optionsOf(shadowed);
    const spreadAt = entries.findIndex(e => /^\.\.\.\s*buildClosureSideEffects\(\s*\)$/.test(e));
    expect(entries.slice(spreadAt + 1).filter(e => e.startsWith('...'))).toEqual(['...overrides']);
  });

  it('FIX-G(b): un spread que NO está en el objeto de opciones del constructor no cuenta', () => {
    const elsewhere = [
      'const opts = { ...buildClosureSideEffects() };',
      'const i = new IngestClosedServiceOrders(a, b, c, d, e, { statusCatalog });',
    ].join('\n');
    expect(elsewhere).toMatch(/\{\s*\.\.\.buildClosureSideEffects\(\)/); // ← el viejo daba VERDE
    const entries = optionsOf(elsewhere);
    expect(entries.some(e => /buildClosureSideEffects/.test(e))).toBe(false);
  });

  it('FIX-G(b): la forma REAL de los tres bootstraps pasa (el pin no es imposible de cumplir)', () => {
    const real =
      'const i = new IngestClosedServiceOrders(a, b, c, d, e, { ...buildClosureSideEffects(), statusCatalog: cat });';
    const entries = optionsOf(real);
    const spreadAt = entries.findIndex(e => /^\.\.\.\s*buildClosureSideEffects\(\s*\)$/.test(e));
    expect(spreadAt).toBe(0);
    expect(entries.slice(spreadAt + 1)).toEqual(['statusCatalog: cat']);
  });
});
