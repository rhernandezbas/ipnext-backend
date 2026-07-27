import type { AssistantOutcome, AssistantSubjectType } from '@domain/entities/assistant';
import type {
  AssistantRunRepository,
  ListAssistantRunsQuery,
} from '@domain/ports/AssistantRunRepository';

export interface AssistantRunDto {
  id: string;
  areaId: string | null;
  subjectType: AssistantSubjectType;
  subjectId: string;
  intentName: string | null;
  dataSources: string[];
  actionKey: string | null;
  outcome: AssistantOutcome;
  reason: string | null;
  latencyMs: number | null;
  createdAt: string;
}

/** Techo duro: una consulta sin `limit` no debe traer el historial entero del asistente. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * ai-assistant-multiagent (OBS-1) — historial de corridas del asistente.
 *
 * Es la herramienta para responder las preguntas que vas a querer hacerle al bot cuando algo
 * salga raro: *¿por qué no contestó?*, *¿cuántas veces se calló pudiendo hablar?*,
 * *¿cuántas respuestas descartó el verificador de números?*
 *
 * Ese último caso (`outcome: 'rejected_numbers'`) es la métrica más valiosa del sistema: cada
 * fila es una alucinación sobre plata que NO llegó al cliente. Si ese número sube, el modelo
 * o el prompt se degradaron — y te enterás por el tablero, no por un reclamo.
 *
 * El DTO NO expone `profileId` (ruido interno) ni ningún contenido: la auditoría registra QUÉ
 * pasó y POR QUÉ, nunca QUÉ SE DIJO. El contenido vive en el hilo, que es su fuente de verdad.
 */
export class ListAssistantRuns {
  constructor(private readonly runs: AssistantRunRepository) {}

  async execute(query: ListAssistantRunsQuery): Promise<{ items: AssistantRunDto[]; total: number }> {
    const limit = Math.min(query.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const { items, total } = await this.runs.list({ ...query, limit });

    return {
      total,
      items: items.map((run) => ({
        id: run.id,
        areaId: run.areaId,
        subjectType: run.subjectType,
        subjectId: run.subjectId,
        intentName: run.intentName,
        dataSources: [...run.dataSources],
        actionKey: run.actionKey,
        outcome: run.outcome,
        reason: run.reason,
        latencyMs: run.latencyMs,
        createdAt: run.createdAt,
      })),
    };
  }
}
