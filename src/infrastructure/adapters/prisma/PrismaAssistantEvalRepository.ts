import type {
  AssistantEvalRepository,
  AssistantEvalRun,
  RecordAssistantEvalRunInput,
} from '@domain/ports/AssistantEvalRepository';
import type { AssistantEvalGate } from '@domain/ports/AssistantEvalGate';
import { prisma } from '../../database/prisma';

interface EvalRow {
  id: string;
  model: string;
  resolutionTotal: number;
  resolutionCorrect: number;
  abstentionTotal: number;
  abstentionCorrect: number;
  notes: string | null;
  createdAt: Date;
}

function toRun(row: EvalRow): AssistantEvalRun {
  return {
    id: row.id,
    model: row.model,
    resolutionTotal: row.resolutionTotal,
    resolutionCorrect: row.resolutionCorrect,
    abstentionTotal: row.abstentionTotal,
    abstentionCorrect: row.abstentionCorrect,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * ai-assistant-multiagent (EVAL-1/EVAL-2) — corridas de evaluación en Prisma.
 *
 * Implementa TAMBIÉN `AssistantEvalGate`: la misma clase responde el "¿hay eval?" que consulta
 * `UpdateAssistantProfile` antes de dejar habilitar una acción de riesgo. Reemplaza al
 * `NoEvalRecordedGate` (placeholder que siempre decía que no).
 */
export class PrismaAssistantEvalRepository implements AssistantEvalRepository, AssistantEvalGate {
  async record(input: RecordAssistantEvalRunInput): Promise<AssistantEvalRun> {
    const row = await prisma.assistantEvalRun.create({ data: input });
    return toRun(row as EvalRow);
  }

  async list(limit: number): Promise<AssistantEvalRun[]> {
    const rows = await prisma.assistantEvalRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => toRun(r as EvalRow));
  }

  async hasAnyRun(): Promise<boolean> {
    return (await prisma.assistantEvalRun.count()) > 0;
  }

  /**
   * EVAL-2 — la pregunta del gate.
   *
   * ⚠️ Ante un error de base devuelve `false`, no propaga. El puerto lo exige: "ante la duda
   * MUST devolver false". Si la consulta falla, lo seguro es NO habilitar una acción que puede
   * enterrar el reclamo de un cliente — no dejar pasar porque el chequeo se rompió.
   */
  async hasRecordedRun(): Promise<boolean> {
    try {
      return await this.hasAnyRun();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[assistant] no se pudo verificar el eval — se deniega por defecto', {
        error: err instanceof Error ? err.message : err,
      });
      return false;
    }
  }
}
