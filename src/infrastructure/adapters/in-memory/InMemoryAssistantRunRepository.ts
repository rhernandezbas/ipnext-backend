import { randomUUID } from 'crypto';
import type { AssistantRun } from '@domain/entities/assistant';
import type {
  AssistantRunRepository,
  ListAssistantRunsQuery,
  RecordAssistantRunInput,
} from '@domain/ports/AssistantRunRepository';

/**
 * ai-assistant-multiagent (T1.4, OBS-1) — auditoría en memoria.
 *
 * Ordena por un contador de inserción DESCENDENTE, no por `createdAt`: dos corridas dentro
 * del mismo milisegundo (perfectamente posible en tests y en ráfagas reales) tendrían el
 * mismo ISO string y el orden quedaría indefinido. El contador lo hace determinístico.
 */
export class InMemoryAssistantRunRepository implements AssistantRunRepository {
  private readonly runs: Array<{ seq: number; run: AssistantRun }> = [];
  private seq = 0;

  async record(input: RecordAssistantRunInput): Promise<AssistantRun> {
    const run: AssistantRun = {
      id: randomUUID(),
      profileId: input.profileId,
      areaId: input.areaId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      intentName: input.intentName,
      dataSources: [...input.dataSources],
      actionKey: input.actionKey,
      outcome: input.outcome,
      reason: input.reason,
      latencyMs: input.latencyMs,
      createdAt: new Date().toISOString(),
    };
    this.runs.push({ seq: this.seq++, run });
    return { ...run, dataSources: [...run.dataSources] };
  }

  async list(query: ListAssistantRunsQuery): Promise<{ items: AssistantRun[]; total: number }> {
    const filtered = this.runs
      .filter(({ run }) => (query.areaId === undefined ? true : run.areaId === query.areaId))
      .filter(({ run }) => (query.outcome === undefined ? true : run.outcome === query.outcome))
      .filter(({ run }) =>
        query.subjectType === undefined ? true : run.subjectType === query.subjectType,
      )
      .filter(({ run }) =>
        query.subjectId === undefined ? true : run.subjectId === query.subjectId,
      )
      .filter(({ run }) => (query.from === undefined ? true : run.createdAt >= query.from))
      .filter(({ run }) => (query.to === undefined ? true : run.createdAt <= query.to))
      .sort((a, b) => b.seq - a.seq);

    const offset = query.offset ?? 0;
    const limit = query.limit ?? filtered.length;

    return {
      items: filtered
        .slice(offset, offset + limit)
        .map(({ run }) => ({ ...run, dataSources: [...run.dataSources] })),
      total: filtered.length,
    };
  }

  /** ANTI-RÁFAGA — sólo `replied` cuenta: un handoff previo no bloquea la próxima respuesta. */
  async hasRepliedSince(conversationId: string, sinceIso: string): Promise<boolean> {
    return this.runs.some(
      ({ run }) =>
        run.subjectId === conversationId &&
        run.outcome === 'replied' &&
        run.createdAt >= sinceIso,
    );
  }
}
