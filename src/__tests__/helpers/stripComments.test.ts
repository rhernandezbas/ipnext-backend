/**
 * El test del stripper. Si esto no está, TODOS los guards de composition-root que lo usan son
 * teatro de segundo orden: un stripper roto que devuelve el fuente tal cual los deja ciegos a
 * comentarios sin que nadie se entere.
 *
 * Vivía adentro de `gigared-composition.cicReuse.test.ts`; se mudó acá cuando el stripper pasó a
 * ser un helper compartido por dos guards.
 */
import { stripComments } from './stripComments';

describe('stripComments', () => {
  it('borra un comentario de línea', () => {
    expect(stripComments('const a = 1; // new RegisterGigaredAccount(x)')).not.toContain(
      'RegisterGigaredAccount',
    );
  });

  it('borra un comentario de bloque', () => {
    expect(stripComments('/* new RegisterGigaredAccount(x) */ const a = 1;')).not.toContain(
      'RegisterGigaredAccount',
    );
  });

  it('borra un bloque MULTILÍNEA (es la forma que toma un wiring comentado de verdad)', () => {
    const src = [
      '/* const x = new Cosa(',
      '  depA, depB,',
      '); */',
      'const x = new Cosa(depA);',
    ].join('\n');
    const out = stripComments(src);
    expect(out).not.toContain('depB');
    expect(out).toContain('new Cosa(depA)');
  });

  it('NO se come el // de una URL', () => {
    expect(stripComments("const url = 'http://x'; // hola")).toContain("'http://x'");
  });

  it('deja el código intacto cuando no hay comentarios', () => {
    expect(stripComments('const a = new Cosa(b, c);')).toBe('const a = new Cosa(b, c);');
  });
});
