import type {
  AssistantIntentRepository,
  AssistantProfileRepository,
} from '@domain/ports/AssistantProfileRepository';
import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import {
  AssistantIntentNameConflictError,
  AssistantProfileNotFoundError,
  UnknownAssistantActionError,
  UnknownAssistantDataSourceError,
} from '@domain/errors/assistant';
import { toAssistantIntentDto, type AssistantIntentDto } from '@application/dto/assistant.dto';

export interface CreateAssistantIntentCommand {
  profileId: string;
  name: string;
  description: string;
  examples?: string[];
  enabled?: boolean;
  dataSourceKeys?: string[];
  responseGuide?: string;
  actionKey: string;
}

/**
 * ai-assistant-multiagent (CFG-2/CFG-3) — agrega una intención a un perfil.
 *
 * Este use case es LA razón de ser del diseño: agregar comportamiento al bot es cargar una
 * fila, no tocar código ni deployar. `description` y `examples[]` son el material que después
 * lee el clasificador (RTR-2).
 *
 * Es también la última barrera antes de persistir: valida contra los catálogos que toda
 * `dataSourceKey` y la `actionKey` existan. Una key inventada acá se convertiría, en runtime,
 * en un silencio inexplicable o en una superficie inesperada.
 */
export class CreateAssistantIntent {
  constructor(
    private readonly profiles: AssistantProfileRepository,
    private readonly intents: AssistantIntentRepository,
    private readonly catalog: AssistantCatalogRepository,
  ) {}

  async execute(command: CreateAssistantIntentCommand): Promise<AssistantIntentDto> {
    const profile = await this.profiles.findById(command.profileId);
    if (!profile) {
      throw new AssistantProfileNotFoundError();
    }

    await assertCatalogKeysExist(this.catalog, command.dataSourceKeys, command.actionKey);

    const siblings = await this.intents.listByProfileId(command.profileId);
    if (siblings.some((i) => i.name === command.name)) {
      throw new AssistantIntentNameConflictError();
    }

    const intent = await this.intents.create({
      profileId: command.profileId,
      name: command.name,
      description: command.description,
      examples: command.examples,
      enabled: command.enabled,
      dataSourceKeys: command.dataSourceKeys,
      responseGuide: command.responseGuide,
      actionKey: command.actionKey,
    });

    return toAssistantIntentDto(intent);
  }
}

/**
 * CFG-3 — validación compartida por el alta y la edición de intenciones.
 *
 * Nota deliberada: se valida que la fuente EXISTA, no que esté habilitada. Referenciar una
 * fuente apagada (p.ej. `noc.cortes` mientras el hub NOC está en modo oscuro) es válido —
 * el motor la omite al resolver el contexto (CFG-3 scenario 2). Así, prender la fuente más
 * adelante no obliga a re-editar todas las intenciones que la usaban.
 */
export async function assertCatalogKeysExist(
  catalog: AssistantCatalogRepository,
  dataSourceKeys: string[] | undefined,
  actionKey: string | undefined,
): Promise<void> {
  if (dataSourceKeys !== undefined && dataSourceKeys.length > 0) {
    const missing = await catalog.findMissingDataSourceKeys(dataSourceKeys);
    if (missing.length > 0) {
      throw new UnknownAssistantDataSourceError(missing);
    }
  }

  if (actionKey !== undefined) {
    const missing = await catalog.findMissingActionKeys([actionKey]);
    if (missing.length > 0) {
      throw new UnknownAssistantActionError(missing);
    }
  }
}
