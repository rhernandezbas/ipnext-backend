import { ListAssistantEvalRuns } from '@application/use-cases/assistant/ListAssistantEvalRuns';
import { SetAssistantDataSourceEnabled } from '@application/use-cases/assistant/SetAssistantDataSourceEnabled';
import { UnknownAssistantDataSourceError } from '@domain/errors/assistant';
import type {
  AssistantEvalRepository,
  AssistantEvalRun,
  RecordAssistantEvalRunInput,
} from '@domain/ports/AssistantEvalRepository';
import { InMemoryAssistantCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantCatalogRepository';

/**
 * Las dos superficies que quedaron sin construir después del change original:
 *
 *  - **listar corridas de eval** — el use case de registro existía pero HUÉRFANO (ninguna ruta
 *    lo llamaba), así que `resolve_conversation` no se podía habilitar nunca.
 *  - **prender/apagar una fuente de datos** — `setDataSourceEnabled` estaba implementado en
 *    los dos adapters y NADIE lo llamaba. El seed dice "se prende con un tilde" y ese tilde
 *    no existía.
 *
 * Mismo patrón las dos veces: la pieza construida, la perilla no.
 */

class FakeEvalRepo implements AssistantEvalRepository {
  runs: AssistantEvalRun[] = [];

  async record(input: RecordAssistantEvalRunInput): Promise<AssistantEvalRun> {
    const run: AssistantEvalRun = {
      id: `run-${this.runs.length}`,
      createdAt: `2026-07-2${this.runs.length}T00:00:00Z`,
      ...input,
    };
    // Más nuevas primero, como devuelve el adapter Prisma (orderBy createdAt desc).
    this.runs.unshift(run);
    return run;
  }
  async list(limit: number): Promise<AssistantEvalRun[]> {
    return this.runs.slice(0, limit);
  }
  async hasAnyRun(): Promise<boolean> {
    return this.runs.length > 0;
  }
}

const RUN: RecordAssistantEvalRunInput = {
  model: 'deepseek-chat',
  resolutionTotal: 80,
  resolutionCorrect: 68,
  abstentionTotal: 20,
  abstentionCorrect: 18,
  notes: '100 conversaciones reales',
};

describe('ListAssistantEvalRuns', () => {
  it('sin corridas devuelve lista vacía, no error', async () => {
    const useCase = new ListAssistantEvalRuns(new FakeEvalRepo());

    await expect(useCase.execute()).resolves.toEqual([]);
  });

  it('deriva las tasas al leer — el operador no divide a mano', async () => {
    const repo = new FakeEvalRepo();
    await repo.record(RUN);

    const [run] = await new ListAssistantEvalRuns(repo).execute();

    expect(run?.resolutionAccuracy).toBeCloseTo(0.85);
    expect(run?.abstentionRate).toBeCloseTo(0.9);
  });

  it('NO serializa los conteos crudos de correctas: la tasa es lo que se lee', async () => {
    const repo = new FakeEvalRepo();
    await repo.record(RUN);

    const [run] = await new ListAssistantEvalRuns(repo).execute();

    // Los totales SÍ (dan tamaño de muestra), los "correct" no: ya están en la tasa.
    expect(run).toHaveProperty('resolutionTotal', 80);
    expect(run).not.toHaveProperty('resolutionCorrect');
  });

  it('acota cuántas devuelve: el historial no puede crecer sin techo en una pantalla', async () => {
    const repo = new FakeEvalRepo();
    for (let i = 0; i < 60; i++) await repo.record(RUN);

    const runs = await new ListAssistantEvalRuns(repo).execute();

    expect(runs.length).toBeLessThanOrEqual(50);
  });
});

describe('SetAssistantDataSourceEnabled', () => {
  it('prende una fuente que venía apagada', async () => {
    // `noc.cortes` nace apagada a propósito (el hub NOC está en modo oscuro). Sin esta
    // perilla nunca se podría prender cuando el hub salga.
    const catalog = new InMemoryAssistantCatalogRepository();

    const updated = await new SetAssistantDataSourceEnabled(catalog).execute('noc.cortes', true);

    expect(updated.enabled).toBe(true);
    const fromCatalog = (await catalog.listDataSources()).find(s => s.key === 'noc.cortes');
    expect(fromCatalog?.enabled).toBe(true);
  });

  it('apaga una que estaba prendida — la decisión es reversible', async () => {
    const catalog = new InMemoryAssistantCatalogRepository();

    const updated = await new SetAssistantDataSourceEnabled(catalog).execute('cliente.saldo', false);

    expect(updated.enabled).toBe(false);
  });

  it('una key inventada se RECHAZA en vez de crear una fuente fantasma', async () => {
    // Frontera R5 del proposal: las fuentes se registran en CÓDIGO, con review. Cada una es
    // una puerta a la base. Fabricarlas por formulario sería una inyección con formulario bonito.
    const catalog = new InMemoryAssistantCatalogRepository();

    await expect(
      new SetAssistantDataSourceEnabled(catalog).execute('cliente.tarjeta_credito', true),
    ).rejects.toBeInstanceOf(UnknownAssistantDataSourceError);
  });

  it('el rechazo NOMBRA la key, para que se vea el typo', async () => {
    const catalog = new InMemoryAssistantCatalogRepository();

    await expect(
      new SetAssistantDataSourceEnabled(catalog).execute('cliente.sald0', true),
    ).rejects.toThrow(/cliente\.sald0/);
  });
});
