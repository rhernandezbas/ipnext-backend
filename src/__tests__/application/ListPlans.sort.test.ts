import { ListPlans } from '@application/use-cases/ListPlans';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { Plan } from '@domain/entities/plan';
import { PlanRepository, PlanUpsert } from '@domain/ports/PlanRepository';

/**
 * TDD — red → green → refactor
 * Cubre todos los scenarios del spec plans-natural-sort.
 *
 * Decisión post-review 2026-07-01: la clave de orden es `code` (lo que muestra el
 * catálogo FE), con desempate por `name` y desempate final por `id` (orden total
 * determinista). Los fixtures usan code !== name para no enmascarar la clave real.
 */

/** Repo stub: devuelve exactamente el array que se le pasa (misma referencia). */
class StubPlanRepository implements PlanRepository {
  constructor(private readonly plans: Plan[]) {}
  async list(): Promise<Plan[]> {
    return this.plans;
  }
  async upsertByCode(_data: PlanUpsert): Promise<Plan> {
    throw new Error('not implemented');
  }
  async findById(_id: string): Promise<Plan | null> {
    return null;
  }
  async findByCode(_code: string): Promise<Plan | null> {
    return null;
  }
  async delete(_id: string): Promise<void> {
    throw new Error('not implemented');
  }
}

function mkPlan(overrides: Partial<Plan>): Plan {
  return {
    id: 'id-x',
    code: 'CODE-X',
    name: 'Name X',
    category: 'Air',
    downloadKbps: 10000,
    uploadKbps: 5000,
    status: 'enabled',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Fixture con code !== name: si el sort usara `name`, el orden esperado (por code)
 * se rompería, porque los names están elegidos en orden alfabético INVERSO al de code.
 */
async function buildRepo(codes: string[]): Promise<InMemoryPlanRepository> {
  const repo = new InMemoryPlanRepository();
  let i = 0;
  for (const code of codes) {
    await repo.upsertByCode({
      code,
      // name deliberadamente contrario al orden de code (Z… para los primeros insertados)
      name: `${String.fromCharCode(90 - i)}-plan-${i}`,
      category: 'Air',
      downloadKbps: 10000,
      uploadKbps: 5000,
    });
    i++;
  }
  return repo;
}

describe('ListPlans — natural sort por code (numeric-aware)', () => {
  // Task 1.1 — secuencia completa de planes Air en orden inverso → debe salir en orden natural por code
  it('ordena planes con segmentos numéricos en orden numérico ascendente (20 < 50 < 100) por code', async () => {
    const repo = await buildRepo([
      'IP-Air-100-30',
      'IP-Air-20-10',
      'IP-Air-80-30',
      'IP-Air-50-15',
      'IP-Air-100-100',
      'IP-Air-50-50',
      'IP-Air-80-80',
    ]);
    const uc = new ListPlans(repo);
    const result = await uc.execute();
    expect(result.map(p => p.code)).toEqual([
      'IP-Air-20-10',
      'IP-Air-50-15',
      'IP-Air-50-50',
      'IP-Air-80-30',
      'IP-Air-80-80',
      'IP-Air-100-30',
      'IP-Air-100-100',
    ]);
  });

  // La clave es code, NO name: names en orden contrario no alteran el orden por code
  it('ordena por code aunque los names tengan orden alfabético contrario', async () => {
    const repo = new InMemoryPlanRepository();
    await repo.upsertByCode({ code: 'IP-Air-100-30', name: 'A-primero-por-name', category: 'Air', downloadKbps: 100000, uploadKbps: 30000 });
    await repo.upsertByCode({ code: 'IP-Air-20-10', name: 'Z-ultimo-por-name', category: 'Air', downloadKbps: 20000, uploadKbps: 10000 });
    const uc = new ListPlans(repo);
    const result = await uc.execute();
    expect(result.map(p => p.code)).toEqual(['IP-Air-20-10', 'IP-Air-100-30']);
  });

  // Task 1.2 — lista vacía
  it('devuelve array vacío sin error cuando no hay planes', async () => {
    const repo = new InMemoryPlanRepository();
    const uc = new ListPlans(repo);
    expect(await uc.execute()).toEqual([]);
  });

  // Task 1.3 — un solo plan
  it('devuelve array de un elemento cuando hay un solo plan', async () => {
    const repo = await buildRepo(['IP-Air-50-15']);
    const uc = new ListPlans(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('IP-Air-50-15');
  });

  // Task 1.4 — codes no-numéricos no crashean, orden determinista
  it('no crashea con codes no-numéricos y produce orden determinista', async () => {
    const repo = await buildRepo(['IP-BAJA', 'IP-REDUCCION', 'IP-Air-20-10']);
    const uc = new ListPlans(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(3);
    const codes = result.map(p => p.code);
    expect(codes).toContain('IP-BAJA');
    expect(codes).toContain('IP-REDUCCION');
    expect(codes).toContain('IP-Air-20-10');
    // IP-Air-20-10 antes que IP-BAJA (A < B en localeCompare con sensitivity:'base')
    expect(codes.indexOf('IP-Air-20-10')).toBeLessThan(codes.indexOf('IP-BAJA'));
  });

  // Scenario del spec — A < Al: el segmento no-numérico decide antes que los números
  it('ordena IP-Air-20-10 antes que IP-Alta-50-20 (Air < Alta, segmento no-numérico)', async () => {
    const repo = await buildRepo(['IP-Alta-50-20', 'IP-Air-20-10']);
    const uc = new ListPlans(repo);
    const result = await uc.execute();
    expect(result.map(p => p.code)).toEqual(['IP-Air-20-10', 'IP-Alta-50-20']);
  });

  // Task 1.5 — case-insensitive
  it('es case-insensitive: ip-air-20-10 aparece antes que IP-Air-100-30', async () => {
    const repo = await buildRepo(['IP-Air-100-30', 'ip-air-20-10']);
    const uc = new ListPlans(repo);
    const result = await uc.execute();
    const codes = result.map(p => p.code);
    // 20 < 100, así que ip-air-20-10 debe ir primero independientemente del case
    expect(codes.indexOf('ip-air-20-10')).toBeLessThan(codes.indexOf('IP-Air-100-30'));
  });

  // Desempate por name cuando los codes natural-comparan igual
  it('desempata por name cuando los codes natural-comparan igual', async () => {
    // 'CODE-01' y 'CODE-1' natural-comparan igual (numeric: 01 == 1) → decide name
    const plans = [
      mkPlan({ id: 'id-b', code: 'CODE-01', name: 'B-name' }),
      mkPlan({ id: 'id-a', code: 'CODE-1', name: 'A-name' }),
    ];
    const uc = new ListPlans(new StubPlanRepository(plans));
    const result = await uc.execute();
    expect(result.map(p => p.id)).toEqual(['id-a', 'id-b']);
  });

  // Orden estable/determinista con names idénticos: se afirma el ORDEN relativo, no solo el count
  it('con name idéntico el orden relativo es determinista por code', async () => {
    const repo = new InMemoryPlanRepository();
    await repo.upsertByCode({ code: 'CODE-B', name: 'IP-Air-50-15', category: 'Air', downloadKbps: 50000, uploadKbps: 15000 });
    await repo.upsertByCode({ code: 'CODE-A', name: 'IP-Air-50-15', category: 'Air', downloadKbps: 50000, uploadKbps: 15000 });
    const uc = new ListPlans(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(2);
    // Orden RELATIVO afirmado: CODE-A antes que CODE-B, sin importar el orden de inserción
    expect(result.map(p => p.code)).toEqual(['CODE-A', 'CODE-B']);
  });

  it('con code y name idénticos el orden relativo es determinista por id (orden total)', async () => {
    const plans = [
      mkPlan({ id: 'id-2', code: 'CODE-X', name: 'Same' }),
      mkPlan({ id: 'id-1', code: 'CODE-X', name: 'Same' }),
    ];
    const uc = new ListPlans(new StubPlanRepository(plans));
    const result = await uc.execute();
    expect(result.map(p => p.id)).toEqual(['id-1', 'id-2']);
  });

  // Guard de null/undefined: un code faltante NUNCA tira TypeError
  it('no crashea con code undefined y lo ubica en posición determinista (al principio)', async () => {
    const plans = [
      mkPlan({ id: 'id-ok', code: 'IP-Air-20-10', name: 'Air 20/10' }),
      mkPlan({ id: 'id-sin-code', code: undefined as unknown as string, name: 'Sin code' }),
    ];
    const uc = new ListPlans(new StubPlanRepository(plans));
    const result = await uc.execute();
    expect(result).toHaveLength(2);
    // (code ?? '') → '' compara antes que cualquier string no vacío → va al principio
    expect(result[0].id).toBe('id-sin-code');
    expect(result[1].id).toBe('id-ok');
  });

  it('no crashea con name null cuando el code empata', async () => {
    const plans = [
      mkPlan({ id: 'id-2', code: 'CODE-X', name: null as unknown as string }),
      mkPlan({ id: 'id-1', code: 'CODE-X', name: 'Con name' }),
    ];
    const uc = new ListPlans(new StubPlanRepository(plans));
    const result = await uc.execute();
    expect(result).toHaveLength(2);
    // name null → '' → antes que 'Con name'
    expect(result[0].id).toBe('id-2');
    expect(result[1].id).toBe('id-1');
  });

  // Sort inmutable: el array del repo NO se muta
  it('no muta el array devuelto por el repo', async () => {
    const plans = [
      mkPlan({ id: 'id-100', code: 'IP-Air-100-30', name: 'Air 100/30' }),
      mkPlan({ id: 'id-20', code: 'IP-Air-20-10', name: 'Air 20/10' }),
    ];
    const uc = new ListPlans(new StubPlanRepository(plans));
    const result = await uc.execute();
    // El resultado está ordenado…
    expect(result.map(p => p.code)).toEqual(['IP-Air-20-10', 'IP-Air-100-30']);
    // …pero el array original del repo conserva su orden (no fue mutado in-place)
    expect(plans.map(p => p.code)).toEqual(['IP-Air-100-30', 'IP-Air-20-10']);
  });
});

describe('InMemoryPlanRepository.list() — sin sort propio (el orden vive SOLO en ListPlans)', () => {
  it('devuelve los planes en orden de inserción (como Prisma devuelve el orden de DB)', async () => {
    const repo = new InMemoryPlanRepository();
    await repo.upsertByCode({ code: 'IP-Air-100-30', name: 'Air 100/30', category: 'Air', downloadKbps: 100000, uploadKbps: 30000 });
    await repo.upsertByCode({ code: 'IP-Air-20-10', name: 'Air 20/10', category: 'Air', downloadKbps: 20000, uploadKbps: 10000 });
    const result = await repo.list();
    // Orden de inserción, NO orden natural: el adapter no ordena
    expect(result.map(p => p.code)).toEqual(['IP-Air-100-30', 'IP-Air-20-10']);
  });
});
