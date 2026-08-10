/**
 * fix wave F5 — ningún `motivo` llega al prompt sin su guía.
 *
 * El test que de verdad discrimina es el TERCERO: escanea el fuente de TODOS los
 * resolvers y exige que cada literal `motivo: '...'` tenga entrada en
 * `MOTIVO_GUIA`. El compilador cubre el union; lo que el compilador NO puede ver
 * es un resolver futuro que devuelva un motivo inventado inline — que es
 * exactamente la forma en que se escribieron los cuatro que había.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MOTIVO_GUIA, motivoNoDisponible, type AssistantMotivo } from '@infrastructure/adapters/assistant/assistantMotivoGuia';

const RESOLVERS_DIR = join(__dirname, '../../../../infrastructure/adapters/assistant');

describe('MOTIVO_GUIA (F5)', () => {
  const motivos = Object.keys(MOTIVO_GUIA) as AssistantMotivo[];

  it('F5 — TODO motivo tiene una guía no vacía y accionable', () => {
    expect(motivos.length).toBeGreaterThan(0);
    for (const motivo of motivos) {
      const guia = MOTIVO_GUIA[motivo];
      expect(typeof guia).toBe('string');
      expect(guia.trim().length).toBeGreaterThan(20); // una guía de 3 palabras no guía nada
    }
  });

  it('F5 — ninguna guía de saldo habilita citar un importe (la razón de ser del disponible:false)', () => {
    for (const motivo of motivos) {
      if (motivo === 'cliente_no_identificado') continue; // ahí ni siquiera hay cliente
      expect(MOTIVO_GUIA[motivo].toLowerCase()).toMatch(/no menciones ningun importe/);
    }
  });

  it('F5 — `motivoNoDisponible` emite motivo y guía SIEMPRE juntos', () => {
    for (const motivo of motivos) {
      expect(motivoNoDisponible(motivo)).toEqual({
        disponible: false,
        motivo,
        guia: MOTIVO_GUIA[motivo],
      });
    }
  });

  /**
   * ⚠️ El pin que caza al resolver futuro. Assertion sobre el TEXTO del fuente,
   * misma decisión (y mismo precio) que `assistant-composition.test.ts`: es feo,
   * y es lo único que ve un `motivo:` escrito a mano fuera del union.
   */
  it('F5 — ningún resolver emite un `motivo:` literal que no esté en MOTIVO_GUIA', () => {
    const files = readdirSync(RESOLVERS_DIR).filter((f) => f.endsWith('Resolver.ts'));
    expect(files.length).toBeGreaterThan(0); // si el glob no matchea nada, el test es humo

    const encontrados = new Set<string>();
    for (const file of files) {
      const src = readFileSync(join(RESOLVERS_DIR, file), 'utf-8');
      // Sólo líneas de código: un `motivo: 'x'` dentro de un comentario no emite nada.
      const codigo = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      // Las DOS formas: la correcta (`motivoNoDisponible('x')`) y la que hay que
      // cazar (`motivo: 'x'` escrito a mano, que es como se escribieron los cuatro
      // originales y como se va a escribir el quinto si nadie mira).
      for (const m of codigo.matchAll(/motivoNoDisponible\(\s*'([a-z_]+)'\s*\)|motivo:\s*'([a-z_]+)'/g)) {
        encontrados.add(m[1] ?? m[2]);
      }
    }

    expect(encontrados.size).toBeGreaterThan(0);
    for (const motivo of encontrados) {
      expect(Object.keys(MOTIVO_GUIA)).toContain(motivo);
    }
  });
});
