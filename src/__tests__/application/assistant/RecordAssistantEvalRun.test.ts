import { RecordAssistantEvalRun } from '@application/use-cases/assistant/RecordAssistantEvalRun';
import { InvalidAssistantEvalRunError } from '@domain/errors/assistant';
import type {
  AssistantEvalRepository,
  AssistantEvalRun,
  RecordAssistantEvalRunInput,
} from '@domain/ports/AssistantEvalRepository';

/**
 * ai-assistant-multiagent (EVAL-1/EVAL-2) — el eval.
 *
 * La regla que se prueba acá no es aritmética: es que **un eval sin partición de abstención
 * no es un eval**. Aceptarlo permitiría destrabar `resolve_conversation` con un número que
 * mide sólo lo fácil e ignora el modo de falla peligroso (que el bot invente en vez de callarse).
 */

class FakeEvalRepo implements AssistantEvalRepository {
  runs: AssistantEvalRun[] = [];

  async record(input: RecordAssistantEvalRunInput): Promise<AssistantEvalRun> {
    const run: AssistantEvalRun = { id: `run-${this.runs.length}`, createdAt: '2026-07-26T00:00:00Z', ...input };
    this.runs.push(run);
    return run;
  }
  async list(limit: number): Promise<AssistantEvalRun[]> {
    return this.runs.slice(0, limit);
  }
  async hasAnyRun(): Promise<boolean> {
    return this.runs.length > 0;
  }
}

const VALID: RecordAssistantEvalRunInput = {
  model: 'deepseek-chat',
  resolutionTotal: 80,
  resolutionCorrect: 68,
  abstentionTotal: 20,
  abstentionCorrect: 18,
  notes: '100 conversaciones reales del inbox',
};

describe('RecordAssistantEvalRun', () => {
  let repo: FakeEvalRepo;
  let useCase: RecordAssistantEvalRun;

  beforeEach(() => {
    repo = new FakeEvalRepo();
    useCase = new RecordAssistantEvalRun(repo);
  });

  it('registra la corrida y deriva las DOS métricas por separado', async () => {
    const dto = await useCase.execute(VALID);

    expect(dto.resolutionAccuracy).toBe(0.85);
    expect(dto.abstentionRate).toBe(0.9);
  });

  it('las métricas NO se persisten, se derivan al leer', async () => {
    await useCase.execute(VALID);

    // Guardar un promedio junto a sus componentes es invitar a que se desincronicen.
    expect(repo.runs[0]).not.toHaveProperty('resolutionAccuracy');
    expect(repo.runs[0]).toMatchObject({ resolutionCorrect: 68, resolutionTotal: 80 });
  });

  // ── La regla que importa ─────────────────────────────────────────────────
  it('EVAL-1: partición de abstención VACÍA ⇒ rechazado', async () => {
    await expect(
      useCase.execute({ ...VALID, abstentionTotal: 0, abstentionCorrect: 0 }),
    ).rejects.toBeInstanceOf(InvalidAssistantEvalRunError);
  });

  it('EVAL-1: el rechazo explica POR QUÉ, no sólo que falló', async () => {
    await expect(
      useCase.execute({ ...VALID, abstentionTotal: 0, abstentionCorrect: 0 }),
    ).rejects.toMatchObject({
      problems: expect.arrayContaining([expect.stringContaining('abstención')]),
    });
  });

  it('EVAL-1: un eval inválido NO se persiste ⇒ el candado sigue cerrado', async () => {
    await expect(
      useCase.execute({ ...VALID, abstentionTotal: 0, abstentionCorrect: 0 }),
    ).rejects.toThrow();

    // Si se hubiera guardado, `hasAnyRun()` daría true y destrabaría las acciones red.
    await expect(repo.hasAnyRun()).resolves.toBe(false);
  });

  it('partición de resolución vacía también se rechaza', async () => {
    await expect(
      useCase.execute({ ...VALID, resolutionTotal: 0, resolutionCorrect: 0 }),
    ).rejects.toBeInstanceOf(InvalidAssistantEvalRunError);
  });

  it('más aciertos que casos ⇒ rechazado (dato imposible)', async () => {
    await expect(useCase.execute({ ...VALID, abstentionCorrect: 25 })).rejects.toBeInstanceOf(
      InvalidAssistantEvalRunError,
    );
  });

  it('totales negativos ⇒ rechazado', async () => {
    await expect(useCase.execute({ ...VALID, resolutionTotal: -1 })).rejects.toBeInstanceOf(
      InvalidAssistantEvalRunError,
    );
  });

  it('un eval perfecto en resolución pero pésimo en abstención se registra igual', async () => {
    // A propósito: el eval REPORTA, no juzga. El operador ve 100% / 10% y decide. Colapsarlo
    // en un promedio de 55% escondería exactamente el problema (caso Gemini 3 Flash).
    const dto = await useCase.execute({
      ...VALID,
      resolutionTotal: 80,
      resolutionCorrect: 80,
      abstentionTotal: 20,
      abstentionCorrect: 2,
    });

    expect(dto.resolutionAccuracy).toBe(1);
    expect(dto.abstentionRate).toBe(0.1);
  });
});
