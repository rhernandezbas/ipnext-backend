import type {
  AssistantIntentRepository,
  AssistantProfileRepository,
} from '@domain/ports/AssistantProfileRepository';
import type { AssistantCatalogRepository } from '@domain/ports/AssistantCatalogRepository';
import {
  AssistantIntentNameConflictError,
  AssistantRoleKeyConflictError,
  AssistantProfileNotFoundError,
  TriggerPatternsRequireHandoffActionError,
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
  /** ai-assistant-cobranzas (D2) */
  labels?: string[];
  /** ai-assistant-cobranzas (D5) — MUST venir vacío salvo que `actionKey === 'handoff'` (CFG-2). */
  triggerPatterns?: string[];
  /** ai-assistant-cobranzas (D10) */
  unassign?: boolean;
  /** ai-assistant-cobranzas (D11) */
  roleKey?: string | null;
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
    assertTriggerPatternsAllowed(command.triggerPatterns, command.actionKey);

    const siblings = await this.intents.listByProfileId(command.profileId);
    if (siblings.some((i) => i.name === command.name)) {
      throw new AssistantIntentNameConflictError();
    }
    assertRoleKeyIsFree(command.roleKey, siblings, null);

    const intent = await this.intents.create({
      profileId: command.profileId,
      name: command.name,
      description: command.description,
      examples: command.examples,
      enabled: command.enabled,
      dataSourceKeys: command.dataSourceKeys,
      responseGuide: command.responseGuide,
      actionKey: command.actionKey,
      labels: command.labels,
      triggerPatterns: command.triggerPatterns,
      unassign: command.unassign,
      roleKey: command.roleKey,
    });

    return toAssistantIntentDto(intent);
  }
}

/**
 * CFG-2 (modificado, D5) — `triggerPatterns` no vacío sólo es válido cuando la intent resuelve
 * a `actionKey:'handoff'`. Compartida por el alta y la edición (la edición resuelve el
 * `actionKey`/`triggerPatterns` EFECTIVOS antes de llamar acá — ver `UpdateAssistantIntent`).
 */
export function assertTriggerPatternsAllowed(
  triggerPatterns: string[] | undefined,
  actionKey: string | undefined,
): void {
  if (triggerPatterns !== undefined && triggerPatterns.length > 0 && actionKey !== 'handoff') {
    throw new TriggerPatternsRequireHandoffActionError();
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


/**
 * CFG-2 (D11) — `roleKey` ÚNICO POR PERFIL. Compartida por el alta y la edición.
 *
 * `null`/`undefined` nunca choca: la mayoría de las intents no tienen rol, y dos "sin rol" no
 * son un empate. `excludeId` es la propia fila en la edición — re-guardarla con su mismo
 * `roleKey` no puede chocar consigo misma.
 */
export function assertRoleKeyIsFree(
  roleKey: string | null | undefined,
  siblings: Array<{ id: string; roleKey: string | null }>,
  excludeId: string | null,
): void {
  if (roleKey === undefined || roleKey === null || roleKey.trim() === '') return;

  const taken = siblings.some((i) => i.id !== excludeId && i.roleKey === roleKey);
  if (taken) throw new AssistantRoleKeyConflictError(roleKey);
}
