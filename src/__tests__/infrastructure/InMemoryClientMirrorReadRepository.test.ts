/**
 * Unit test for the in-memory read-only client mirror adapter.
 * Verifies it returns exactly the seeded grClienteId set and exposes no
 * mutators a read-only consumer could misuse (ISP / read-only invariant).
 */
import { InMemoryClientMirrorReadRepository } from '../../infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository';
import type { ClientMirrorReadRepository } from '../../domain/ports/ClientMirrorReadRepository';

describe('InMemoryClientMirrorReadRepository', () => {
  it('returns exactly the seeded grClienteId set', async () => {
    const repo = new InMemoryClientMirrorReadRepository(['A', 'B', 'C']);
    await expect(repo.listGrClienteIds()).resolves.toEqual(['A', 'B', 'C']);
  });

  it('returns an empty array when not seeded', async () => {
    const repo = new InMemoryClientMirrorReadRepository();
    await expect(repo.listGrClienteIds()).resolves.toEqual([]);
  });

  it('reflects ids set after construction via the settable backing field', async () => {
    const repo = new InMemoryClientMirrorReadRepository();
    repo.ids = ['X', 'Y'];
    await expect(repo.listGrClienteIds()).resolves.toEqual(['X', 'Y']);
  });

  // finance-growth Fase 3 — este guard afirmaba `toEqual(['listGrClienteIds'])`, o sea
  // congelaba el CONTEO de métodos. Pero la invariante que el docblock de arriba dice
  // proteger es otra y más precisa: "exposes NO MUTATORS a read-only consumer could
  // misuse (ISP / read-only invariant)". Agregar un segundo método de LECTURA
  // (`getGrClienteIdsByClientIds`, el join `Client.id` → `Client.grClienteId` que el
  // motor de métricas necesita para cruzar contratos con cobranza) NO viola esa
  // invariante; congelar la lista sí habría obligado a inventar un port paralelo para
  // la misma tabla, que es peor diseño.
  //
  // La lista explícita se CONSERVA a propósito (agregar un método sigue siendo una
  // decisión consciente que rompe el test), pero ahora además se afirma la invariante
  // REAL: ninguno de los métodos expuestos puede tener forma de mutador.
  it('satisfies the ClientMirrorReadRepository port — read-only surface, sin mutadores', () => {
    const repo: ClientMirrorReadRepository = new InMemoryClientMirrorReadRepository(['A']);
    expect(typeof repo.listGrClienteIds).toBe('function');
    expect(typeof repo.getGrClienteIdsByClientIds).toBe('function');

    const methods = Object.getOwnPropertyNames(InMemoryClientMirrorReadRepository.prototype)
      .filter(name => name !== 'constructor');
    expect(methods.sort()).toEqual(['getGrClienteIdsByClientIds', 'listGrClienteIds']);

    // La invariante de verdad: cero mutadores en un port de sólo lectura.
    const MUTATOR_SHAPES = /^(save|create|update|upsert|delete|remove|insert|set|write|persist|clear|reset|add|put|patch)/i;
    expect(methods.filter(name => MUTATOR_SHAPES.test(name))).toEqual([]);
  });
});
