import type {
  AssistantOutcome,
  AssistantRun,
  AssistantSubjectType,
} from '@domain/entities/assistant';
import type {
  AssistantRunRepository,
  ListAssistantRunsQuery,
  RecordAssistantRunInput,
} from '@domain/ports/AssistantRunRepository';
import { prisma } from '../../database/prisma';

/**
 * ai-assistant-multiagent (T1.5, OBS-1) — auditoría en Prisma.
 *
 * NO persiste contenido: ni el mensaje del cliente, ni el prompt, ni la respuesta generada.
 * Sólo QUÉ pasó y POR QUÉ. El contenido ya vive en el hilo de la conversación / el ticket,
 * que es su fuente de verdad — duplicarlo acá sería crear una segunda copia de PII con
 * distinto ciclo de vida y sin las mismas protecciones.
 */

interface RunRow {
  id: string;
  profileId: string | null;
  areaId: string | null;
  subjectType: string;
  subjectId: string;
  intentName: string | null;
  dataSources: string[];
  actionKey: string | null;
  outcome: string;
  reason: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

function toRun(row: RunRow): AssistantRun {
  return {
    id: row.id,
    profileId: row.profileId,
    areaId: row.areaId,
    subjectType: row.subjectType as AssistantSubjectType,
    subjectId: row.subjectId,
    intentName: row.intentName,
    dataSources: [...row.dataSources],
    actionKey: row.actionKey,
    outcome: row.outcome as AssistantOutcome,
    reason: row.reason,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaAssistantRunRepository implements AssistantRunRepository {
  async record(input: RecordAssistantRunInput): Promise<AssistantRun> {
    const row = await prisma.assistantRun.create({
      data: {
        profileId: input.profileId,
        areaId: input.areaId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        intentName: input.intentName,
        dataSources: input.dataSources,
        actionKey: input.actionKey,
        outcome: input.outcome,
        reason: input.reason,
        latencyMs: input.latencyMs,
      },
    });
    return toRun(row as RunRow);
  }

  async list(query: ListAssistantRunsQuery): Promise<{ items: AssistantRun[]; total: number }> {
    const where = {
      ...(query.areaId === undefined ? {} : { areaId: query.areaId }),
      ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      ...(query.subjectType === undefined ? {} : { subjectType: query.subjectType }),
      ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            createdAt: {
              ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
              ...(query.to === undefined ? {} : { lte: new Date(query.to) }),
            },
          }),
    };

    // `count` + `findMany` en paralelo: el total es para la paginación del FE.
    const [rows, total] = await Promise.all([
      prisma.assistantRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.offset ?? 0,
        ...(query.limit === undefined ? {} : { take: query.limit }),
      }),
      prisma.assistantRun.count({ where }),
    ]);

    return { items: rows.map((r) => toRun(r as RunRow)), total };
  }

  /** ANTI-RÁFAGA — `count` acotado, no un findMany: sólo interesa si existe al menos uno. */
  async hasRepliedSince(conversationId: string, sinceIso: string): Promise<boolean> {
    const count = await prisma.assistantRun.count({
      where: {
        subjectId: conversationId,
        outcome: 'replied',
        createdAt: { gte: new Date(sinceIso) },
      },
    });
    return count > 0;
  }
}
