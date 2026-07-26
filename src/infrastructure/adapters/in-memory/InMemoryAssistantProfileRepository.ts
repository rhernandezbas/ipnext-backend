import { randomUUID } from 'crypto';
import type { AssistantIntent, AssistantProfile } from '@domain/entities/assistant';
import type {
  AssistantIntentRepository,
  AssistantProfileRepository,
  CreateAssistantIntentInput,
  CreateAssistantProfileInput,
  UpdateAssistantIntentInput,
  UpdateAssistantProfileInput,
} from '@domain/ports/AssistantProfileRepository';

/**
 * ai-assistant-multiagent (T1.4) — perfiles en memoria. Espeja el contrato del adapter
 * Prisma: los use cases se testean contra ESTE, así que una divergencia entre ambos deja
 * la suite verde y rompe producción.
 *
 * CFG-1: `create` NUNCA acepta `enabled` — el perfil nace apagado y habilitarlo es siempre
 * un acto posterior y explícito.
 */
export class InMemoryAssistantProfileRepository implements AssistantProfileRepository {
  private readonly profiles = new Map<string, AssistantProfile>();

  async findByAreaId(areaId: string): Promise<AssistantProfile | null> {
    const found = [...this.profiles.values()].find((p) => p.areaId === areaId);
    return found ? { ...found, enabledActions: [...found.enabledActions] } : null;
  }

  async findById(id: string): Promise<AssistantProfile | null> {
    const found = this.profiles.get(id);
    return found ? { ...found, enabledActions: [...found.enabledActions] } : null;
  }

  async list(): Promise<AssistantProfile[]> {
    return [...this.profiles.values()].map((p) => ({ ...p, enabledActions: [...p.enabledActions] }));
  }

  async create(input: CreateAssistantProfileInput): Promise<AssistantProfile> {
    // Espeja el `@unique` de `AssistantProfile.areaId`: un área tiene a lo sumo un perfil.
    if ([...this.profiles.values()].some((p) => p.areaId === input.areaId)) {
      throw new Error(`AssistantProfile already exists for area ${input.areaId}`);
    }

    const now = new Date().toISOString();
    const profile: AssistantProfile = {
      id: randomUUID(),
      areaId: input.areaId,
      // CFG-1 — literal, no derivado del input: no hay forma de nacer habilitado.
      enabled: false,
      persona: input.persona ?? '',
      handoffMessage: input.handoffMessage ?? '',
      model: input.model ?? 'deepseek-chat',
      classifierModel: input.classifierModel ?? null,
      timeoutMs: input.timeoutMs ?? 20000,
      // ACT-2 — instalación nueva sin ninguna acción activa.
      enabledActions: [],
      createdAt: now,
      updatedAt: now,
    };
    this.profiles.set(profile.id, profile);
    return { ...profile, enabledActions: [] };
  }

  async update(id: string, input: UpdateAssistantProfileInput): Promise<AssistantProfile | null> {
    const existing = this.profiles.get(id);
    if (!existing) return null;

    const updated: AssistantProfile = {
      ...existing,
      // `undefined` = no tocar (patch parcial).
      enabled: input.enabled ?? existing.enabled,
      persona: input.persona ?? existing.persona,
      handoffMessage: input.handoffMessage ?? existing.handoffMessage,
      model: input.model ?? existing.model,
      classifierModel:
        input.classifierModel === undefined ? existing.classifierModel : input.classifierModel,
      timeoutMs: input.timeoutMs ?? existing.timeoutMs,
      // REEMPLAZO completo, sin merge: el editor de la UI manda el set entero.
      enabledActions: input.enabledActions ? [...input.enabledActions] : existing.enabledActions,
      updatedAt: new Date().toISOString(),
    };
    this.profiles.set(id, updated);
    return { ...updated, enabledActions: [...updated.enabledActions] };
  }

  async delete(id: string): Promise<boolean> {
    return this.profiles.delete(id);
  }
}

/**
 * ai-assistant-multiagent (T1.4) — intenciones en memoria.
 *
 * CFG-2: son FILAS, no un enum. Nacen HABILITADAS (a diferencia del perfil): una intención
 * cargada es una intención que se quiere usar, y el interruptor de seguridad global es el
 * `enabled` del perfil, no el de cada fila.
 */
export class InMemoryAssistantIntentRepository implements AssistantIntentRepository {
  private readonly intents = new Map<string, AssistantIntent>();

  private clone(intent: AssistantIntent): AssistantIntent {
    return { ...intent, examples: [...intent.examples], dataSourceKeys: [...intent.dataSourceKeys] };
  }

  async listByProfileId(profileId: string): Promise<AssistantIntent[]> {
    return [...this.intents.values()]
      .filter((i) => i.profileId === profileId)
      .map((i) => this.clone(i));
  }

  /** RTR-2 — universo de candidatas del clasificador: enabled Y del perfil pedido. */
  async listEnabledByProfileId(profileId: string): Promise<AssistantIntent[]> {
    return [...this.intents.values()]
      .filter((i) => i.profileId === profileId && i.enabled)
      .map((i) => this.clone(i));
  }

  async findById(id: string): Promise<AssistantIntent | null> {
    const found = this.intents.get(id);
    return found ? this.clone(found) : null;
  }

  async create(input: CreateAssistantIntentInput): Promise<AssistantIntent> {
    // Espeja `@@unique([profileId, name])` — el mismo nombre en OTRO perfil es válido.
    const duplicated = [...this.intents.values()].some(
      (i) => i.profileId === input.profileId && i.name === input.name,
    );
    if (duplicated) {
      throw new Error(`AssistantIntent "${input.name}" already exists in profile ${input.profileId}`);
    }

    const now = new Date().toISOString();
    const intent: AssistantIntent = {
      id: randomUUID(),
      profileId: input.profileId,
      name: input.name,
      description: input.description,
      examples: input.examples ? [...input.examples] : [],
      enabled: input.enabled ?? true,
      dataSourceKeys: input.dataSourceKeys ? [...input.dataSourceKeys] : [],
      responseGuide: input.responseGuide ?? '',
      actionKey: input.actionKey,
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(intent.id, intent);
    return this.clone(intent);
  }

  async update(id: string, input: UpdateAssistantIntentInput): Promise<AssistantIntent | null> {
    const existing = this.intents.get(id);
    if (!existing) return null;

    const updated: AssistantIntent = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      examples: input.examples ? [...input.examples] : existing.examples,
      enabled: input.enabled ?? existing.enabled,
      dataSourceKeys: input.dataSourceKeys ? [...input.dataSourceKeys] : existing.dataSourceKeys,
      responseGuide: input.responseGuide ?? existing.responseGuide,
      actionKey: input.actionKey ?? existing.actionKey,
      updatedAt: new Date().toISOString(),
    };
    this.intents.set(id, updated);
    return this.clone(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.intents.delete(id);
  }
}
