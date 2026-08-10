import { AssistantDataSourceRegistryImpl } from '@infrastructure/adapters/assistant/AssistantDataSourceRegistryImpl';
import { OsAbiertasResolver } from '@infrastructure/adapters/assistant/OsAbiertasResolver';
import { ASSISTANT_DATA_SOURCE_SEED } from '@domain/ports/AssistantCatalogRepository';
import type { ListTasks } from '@application/use-cases/ListTasks';
import type { ScheduledTask } from '@domain/entities/scheduling';
import { MOTIVO_GUIA } from '@infrastructure/adapters/assistant/assistantMotivoGuia';
import type {
  AssistantDataSourceResolver,
  AssistantSubjectContext,
} from '@domain/ports/AssistantDataSourceRegistry';

const stub = (key: string): AssistantDataSourceResolver => ({ key, resolve: async () => ({}) });

const ctx: AssistantSubjectContext = {
  clientId: 'client-1',
  conversationId: 'conv-1',
  areaId: 'area-1',
};

describe('AssistantDataSourceRegistryImpl', () => {
  it('resuelve por key y devuelve null para una key desconocida', () => {
    const registry = new AssistantDataSourceRegistryImpl([stub('cliente.saldo')]);

    expect(registry.get('cliente.saldo')?.key).toBe('cliente.saldo');
    expect(registry.get('inventada')).toBeNull();
  });

  it('falla al BOOT si hay dos resolvers para la misma key', () => {
    // Cuál gana dependería del orden del array — eso es un bug de wiring, no una config.
    expect(() => new AssistantDataSourceRegistryImpl([stub('a'), stub('a')])).toThrow(
      /Duplicate assistant data source resolver/,
    );
  });

  it('toda key registrada existe en el catálogo canónico (no hay resolvers huérfanos)', () => {
    const registry = new AssistantDataSourceRegistryImpl([
      stub('cliente.saldo'),
      stub('cliente.servicio'),
      stub('os.abiertas'),
    ]);
    const catalogKeys = new Set(ASSISTANT_DATA_SOURCE_SEED.map((s) => s.key));

    for (const key of registry.keys()) {
      expect(catalogKeys.has(key)).toBe(true);
    }
  });

  it('noc.cortes está en el catálogo pero SIN resolver — las dos capas coinciden', () => {
    // No es un olvido: no existe un mapeo confiable cliente→zona→alerta. Un resolver que
    // adivinara respondería "no hay cortes" sin respaldo, que es el modo de falla a evitar.
    const registry = new AssistantDataSourceRegistryImpl([stub('cliente.saldo')]);
    const catalogEntry = ASSISTANT_DATA_SOURCE_SEED.find((s) => s.key === 'noc.cortes');

    expect(catalogEntry?.enabled).toBe(false);
    expect(registry.get('noc.cortes')).toBeNull();
  });
});

describe('OsAbiertasResolver', () => {
  const taskOf = (startDate: string | null): ScheduledTask =>
    ({ startDate, generalStatus: 'open' }) as unknown as ScheduledTask;

  const listTasksOf = (tasks: ScheduledTask[]): ListTasks =>
    ({ execute: async () => tasks }) as unknown as ListTasks;

  it('cuenta las abiertas y devuelve la próxima fecha', async () => {
    const resolver = new OsAbiertasResolver(
      listTasksOf([taskOf('2026-08-20T10:00:00-03:00'), taskOf('2026-08-12T09:00:00-03:00')]),
    );

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      cantidad: 2,
      proximaFecha: '2026-08-12T09:00:00-03:00',
    });
  });

  it('distingue "abierta sin turno" de "no hay nada"', async () => {
    // Responder "no tenés visitas" a alguien con un reclamo vivo pero sin fecha es mentirle.
    const resolver = new OsAbiertasResolver(listTasksOf([taskOf(null)]));

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      cantidad: 1,
      proximaFecha: null,
      hayAbiertasSinFecha: true,
    });
  });

  it('sin tareas abiertas devuelve cero limpio', async () => {
    const resolver = new OsAbiertasResolver(listTasksOf([]));

    await expect(resolver.resolve(ctx)).resolves.toMatchObject({
      cantidad: 0,
      proximaFecha: null,
      hayAbiertasSinFecha: false,
    });
  });

  it('NO expone el título de la tarea (suele traer nombre y domicilio del titular)', async () => {
    const withTitle = { startDate: null, title: 'Instalación Juan Pérez, Mitre 1234' };
    const resolver = new OsAbiertasResolver(
      listTasksOf([withTitle as unknown as ScheduledTask]),
    );

    const facts = await resolver.resolve(ctx);

    expect(JSON.stringify(facts)).not.toContain('Juan Pérez');
    expect(JSON.stringify(facts)).not.toContain('Mitre');
  });

  it('conversación sin cliente identificado no aporta hechos', async () => {
    const resolver = new OsAbiertasResolver(listTasksOf([]));

    await expect(resolver.resolve({ ...ctx, clientId: null })).resolves.toEqual({
      disponible: false,
      motivo: 'cliente_no_identificado',
      guia: MOTIVO_GUIA.cliente_no_identificado,
    });
  });
});
