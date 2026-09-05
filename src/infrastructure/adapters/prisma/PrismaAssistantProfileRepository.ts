import type { AssistantIntent, AssistantProfile } from '@domain/entities/assistant';
import type {
  AssistantIntentRepository,
  AssistantProfileRepository,
  CreateAssistantIntentInput,
  CreateAssistantProfileInput,
  UpdateAssistantIntentInput,
  UpdateAssistantProfileInput,
} from '@domain/ports/AssistantProfileRepository';
import { prisma } from '../../database/prisma';

/**
 * ai-assistant-multiagent (T1.5) — adapters Prisma de la configuración de agentes.
 *
 * El contrato es el MISMO que testea `InMemoryAssistantRepositories.test.ts`: los use cases
 * corren contra el in-memory, así que una divergencia entre ambos deja la suite verde y
 * rompe producción. Cualquier cambio de semántica acá va con su espejo en el in-memory.
 */

interface ProfileRow {
  id: string;
  areaId: string;
  enabled: boolean;
  persona: string;
  handoffMessage: string;
  model: string;
  classifierModel: string | null;
  timeoutMs: number;
  enabledActions: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface IntentRow {
  id: string;
  profileId: string;
  name: string;
  description: string;
  examples: string[];
  enabled: boolean;
  dataSourceKeys: string[];
  responseGuide: string;
  actionKey: string;
  labels: string[];
  triggerPatterns: string[];
  unassign: boolean;
  roleKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toProfile(row: ProfileRow): AssistantProfile {
  return {
    id: row.id,
    areaId: row.areaId,
    enabled: row.enabled,
    persona: row.persona,
    handoffMessage: row.handoffMessage,
    model: row.model,
    classifierModel: row.classifierModel,
    timeoutMs: row.timeoutMs,
    enabledActions: [...row.enabledActions],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toIntent(row: IntentRow): AssistantIntent {
  return {
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    description: row.description,
    examples: [...row.examples],
    enabled: row.enabled,
    dataSourceKeys: [...row.dataSourceKeys],
    responseGuide: row.responseGuide,
    actionKey: row.actionKey,
    // ai-assistant-cobranzas (D2/D5/D10/D11) — passthrough directo de las columnas aditivas.
    labels: [...row.labels],
    triggerPatterns: [...row.triggerPatterns],
    unassign: row.unassign,
    roleKey: row.roleKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaAssistantProfileRepository implements AssistantProfileRepository {
  async findByAreaId(areaId: string): Promise<AssistantProfile | null> {
    const row = await prisma.assistantProfile.findUnique({ where: { areaId } });
    return row ? toProfile(row as ProfileRow) : null;
  }

  async findById(id: string): Promise<AssistantProfile | null> {
    const row = await prisma.assistantProfile.findUnique({ where: { id } });
    return row ? toProfile(row as ProfileRow) : null;
  }

  async list(): Promise<AssistantProfile[]> {
    const rows = await prisma.assistantProfile.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => toProfile(r as ProfileRow));
  }

  /**
   * CFG-1 — `enabled` NO se pasa: cae al `@default(false)` del schema. El input del port
   * tampoco lo declara, así que no hay forma de nacer habilitado ni por accidente.
   * Un `areaId` repetido choca contra el `@unique` y lanza (P2002), igual que el in-memory.
   */
  async create(input: CreateAssistantProfileInput): Promise<AssistantProfile> {
    const row = await prisma.assistantProfile.create({
      data: {
        areaId: input.areaId,
        persona: input.persona ?? '',
        handoffMessage: input.handoffMessage ?? '',
        ...(input.model === undefined ? {} : { model: input.model }),
        classifierModel: input.classifierModel ?? null,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      },
    });
    return toProfile(row as ProfileRow);
  }

  async update(id: string, input: UpdateAssistantProfileInput): Promise<AssistantProfile | null> {
    const existing = await prisma.assistantProfile.findUnique({ where: { id } });
    if (!existing) return null;

    const row = await prisma.assistantProfile.update({
      where: { id },
      data: {
        // `undefined` = Prisma no toca el campo (patch parcial, misma semántica que in-memory).
        enabled: input.enabled,
        persona: input.persona,
        handoffMessage: input.handoffMessage,
        model: input.model,
        classifierModel: input.classifierModel,
        timeoutMs: input.timeoutMs,
        // REEMPLAZO completo del array, sin merge.
        ...(input.enabledActions === undefined ? {} : { enabledActions: input.enabledActions }),
      },
    });
    return toProfile(row as ProfileRow);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await prisma.assistantProfile.findUnique({ where: { id } });
    if (!existing) return false;
    await prisma.assistantProfile.delete({ where: { id } });
    return true;
  }
}

export class PrismaAssistantIntentRepository implements AssistantIntentRepository {
  async listByProfileId(profileId: string): Promise<AssistantIntent[]> {
    const rows = await prisma.assistantIntent.findMany({
      where: { profileId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => toIntent(r as IntentRow));
  }

  /** RTR-2 — el filtro `enabled` va en el WHERE, no en memoria: es el universo del clasificador. */
  async listEnabledByProfileId(profileId: string): Promise<AssistantIntent[]> {
    const rows = await prisma.assistantIntent.findMany({
      where: { profileId, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => toIntent(r as IntentRow));
  }

  async findById(id: string): Promise<AssistantIntent | null> {
    const row = await prisma.assistantIntent.findUnique({ where: { id } });
    return row ? toIntent(row as IntentRow) : null;
  }

  /** Un `name` repetido en el MISMO perfil choca contra `@@unique([profileId, name])`. */
  async create(input: CreateAssistantIntentInput): Promise<AssistantIntent> {
    const row = await prisma.assistantIntent.create({
      data: {
        profileId: input.profileId,
        name: input.name,
        description: input.description,
        examples: input.examples ?? [],
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        dataSourceKeys: input.dataSourceKeys ?? [],
        responseGuide: input.responseGuide ?? '',
        actionKey: input.actionKey,
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.triggerPatterns === undefined ? {} : { triggerPatterns: input.triggerPatterns }),
        ...(input.unassign === undefined ? {} : { unassign: input.unassign }),
        ...(input.roleKey === undefined ? {} : { roleKey: input.roleKey }),
      },
    });
    return toIntent(row as IntentRow);
  }

  async update(id: string, input: UpdateAssistantIntentInput): Promise<AssistantIntent | null> {
    const existing = await prisma.assistantIntent.findUnique({ where: { id } });
    if (!existing) return null;

    const row = await prisma.assistantIntent.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        ...(input.examples === undefined ? {} : { examples: input.examples }),
        enabled: input.enabled,
        ...(input.dataSourceKeys === undefined ? {} : { dataSourceKeys: input.dataSourceKeys }),
        responseGuide: input.responseGuide,
        actionKey: input.actionKey,
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.triggerPatterns === undefined ? {} : { triggerPatterns: input.triggerPatterns }),
        unassign: input.unassign,
        ...(input.roleKey === undefined ? {} : { roleKey: input.roleKey }),
      },
    });
    return toIntent(row as IntentRow);
  }

  async delete(id: string): Promise<boolean> {
    const existing = await prisma.assistantIntent.findUnique({ where: { id } });
    if (!existing) return false;
    await prisma.assistantIntent.delete({ where: { id } });
    return true;
  }
}
