import { ResolveAssistantFacts } from '@application/use-cases/assistant/ResolveAssistantFacts';
import { InMemoryAssistantCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantCatalogRepository';
import { AssistantPiiLeakError } from '@domain/errors/assistant';
import type {
  AssistantDataSourceRegistry,
  AssistantDataSourceResolver,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';

/** Registry de prueba armado con resolvers falsos, sin tocar Prisma. */
function registryOf(resolvers: AssistantDataSourceResolver[]): AssistantDataSourceRegistry {
  const map = new Map(resolvers.map((r) => [r.key, r]));
  return {
    get: (key) => map.get(key) ?? null,
    keys: () => [...map.keys()],
  };
}

const resolverOf = (
  key: string,
  facts: Record<string, unknown>,
): AssistantDataSourceResolver => ({
  key,
  resolve: async () => facts,
});

const ctx: AssistantSubjectContext = {
  clientId: 'client-1',
  conversationId: 'conv-1',
  areaId: 'area-1',
};

describe('ResolveAssistantFacts', () => {
  let catalog: InMemoryAssistantCatalogRepository;

  beforeEach(() => {
    catalog = new InMemoryAssistantCatalogRepository();
  });

  it('resuelve SÓLO las fuentes pedidas por la intención', async () => {
    const useCase = new ResolveAssistantFacts(
      catalog,
      registryOf([
        resolverOf('cliente.saldo', { saldo: 45000 }),
        resolverOf('cliente.servicio', { estado: 'activo' }),
      ]),
    );

    const { facts, resolvedKeys } = await useCase.execute(['cliente.saldo'], ctx);

    expect(resolvedKeys).toEqual(['cliente.saldo']);
    expect(facts).toEqual({ 'cliente.saldo': { saldo: 45000 } });
    expect(facts['cliente.servicio']).toBeUndefined();
  });

  it('sin keys devuelve hechos vacíos sin consultar nada', async () => {
    const useCase = new ResolveAssistantFacts(catalog, registryOf([]));

    await expect(useCase.execute([], ctx)).resolves.toEqual({ facts: {}, resolvedKeys: [] });
  });

  // ── CFG-3 scenario 2 ──────────────────────────────────────────────────────
  it('CFG-3: una fuente DESHABILITADA se omite y el resto se arma igual', async () => {
    const useCase = new ResolveAssistantFacts(
      catalog,
      registryOf([
        resolverOf('cliente.saldo', { saldo: 45000 }),
        // noc.cortes viene deshabilitada del seed (hub NOC en modo oscuro)
        resolverOf('noc.cortes', { hayCorteEnZona: false }),
      ]),
    );

    const { facts, resolvedKeys } = await useCase.execute(['cliente.saldo', 'noc.cortes'], ctx);

    expect(resolvedKeys).toEqual(['cliente.saldo']);
    // Lo importante: NO afirma "no hay cortes" cuando en realidad no sabe.
    expect(facts['noc.cortes']).toBeUndefined();
  });

  it('CFG-3: al habilitar la fuente, empieza a resolverse sin tocar la intención', async () => {
    await catalog.setDataSourceEnabled('noc.cortes', true);
    const useCase = new ResolveAssistantFacts(
      catalog,
      registryOf([resolverOf('noc.cortes', { hayCorteEnZona: true })]),
    );

    const { resolvedKeys } = await useCase.execute(['noc.cortes'], ctx);

    expect(resolvedKeys).toEqual(['noc.cortes']);
  });

  it('una key sin resolver registrado se omite con warn, no revienta', async () => {
    const useCase = new ResolveAssistantFacts(catalog, registryOf([]));

    const { facts, resolvedKeys } = await useCase.execute(['cliente.saldo'], ctx);

    expect(resolvedKeys).toEqual([]);
    expect(facts).toEqual({});
  });

  // ── Aislamiento (disciplina RUN-1) ───────────────────────────────────────
  it('un resolver que falla se omite y los demás sobreviven', async () => {
    const exploding: AssistantDataSourceResolver = {
      key: 'cliente.servicio',
      resolve: async () => {
        throw new Error('la base tosió');
      },
    };
    const useCase = new ResolveAssistantFacts(
      catalog,
      registryOf([resolverOf('cliente.saldo', { saldo: 45000 }), exploding]),
    );

    const { facts, resolvedKeys } = await useCase.execute(
      ['cliente.saldo', 'cliente.servicio'],
      ctx,
    );

    expect(resolvedKeys).toEqual(['cliente.saldo']);
    expect(facts['cliente.saldo']).toEqual({ saldo: 45000 });
  });

  // ── SEC-1: la barrera dura ───────────────────────────────────────────────
  it('SEC-1: un resolver que filtra una CLAVE de identidad hace lanzar', async () => {
    const leaky = resolverOf('cliente.saldo', { saldo: 45000, email: 'juan@gmail.com' });
    const useCase = new ResolveAssistantFacts(catalog, registryOf([leaky]));

    await expect(useCase.execute(['cliente.saldo'], ctx)).rejects.toBeInstanceOf(
      AssistantPiiLeakError,
    );
  });

  it('SEC-1: un resolver que filtra el NOMBRE real del cliente hace lanzar', async () => {
    const leaky = resolverOf('cliente.saldo', { saldo: 45000, titular: 'Juan Pérez' });
    const useCase = new ResolveAssistantFacts(catalog, registryOf([leaky]));

    await expect(useCase.execute(['cliente.saldo'], ctx, ['Juan Pérez'])).rejects.toBeInstanceOf(
      AssistantPiiLeakError,
    );
  });

  it('SEC-1: la barrera corre sobre el objeto ENSAMBLADO, no por resolver', async () => {
    // Cada resolver por separado luce inocente; la fuga aparece recién al combinarlos.
    const useCase = new ResolveAssistantFacts(
      catalog,
      registryOf([
        resolverOf('cliente.saldo', { saldo: 45000 }),
        resolverOf('cliente.servicio', { estado: 'activo', phone: '+5492964...' }),
      ]),
    );

    await expect(
      useCase.execute(['cliente.saldo', 'cliente.servicio'], ctx),
    ).rejects.toBeInstanceOf(AssistantPiiLeakError);
  });

  it('hechos limpios pasan la barrera sin ruido', async () => {
    const useCase = new ResolveAssistantFacts(
      catalog,
      registryOf([resolverOf('cliente.saldo', { saldo: 45000, vencimiento: '2026-08-10' })]),
    );

    await expect(useCase.execute(['cliente.saldo'], ctx, ['Juan Pérez'])).resolves.toMatchObject({
      resolvedKeys: ['cliente.saldo'],
    });
  });
});
