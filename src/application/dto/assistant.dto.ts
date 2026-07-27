import type {
  AssistantActionEntry,
  AssistantDataSourceEntry,
  AssistantIntent,
  AssistantProfile,
  AssistantRiskLevel,
} from '@domain/entities/assistant';

/**
 * ai-assistant-multiagent — DTOs de la capa de configuración.
 *
 * ⚠️ CONTRATO BE↔FE. Se construyen campo por campo, jamás con spread de la entidad: un
 * campo nuevo en el modelo NO debe filtrarse solo al FE. (Lección W6 del EPIC #38: BE y FE
 * construidos en paralelo desde el spec driftaron y la página renderizó filas en blanco.)
 */

export interface AssistantProfileDto {
  id: string;
  areaId: string;
  enabled: boolean;
  persona: string;
  handoffMessage: string;
  model: string;
  classifierModel: string | null;
  timeoutMs: number;
  enabledActions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AssistantIntentDto {
  id: string;
  profileId: string;
  name: string;
  description: string;
  examples: string[];
  enabled: boolean;
  dataSourceKeys: string[];
  responseGuide: string;
  actionKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantDataSourceDto {
  key: string;
  label: string;
  enabled: boolean;
}

export interface AssistantActionDto {
  key: string;
  label: string;
  riskLevel: AssistantRiskLevel;
}

export interface AssistantCatalogsDto {
  dataSources: AssistantDataSourceDto[];
  actions: AssistantActionDto[];
}

export function toAssistantProfileDto(profile: AssistantProfile): AssistantProfileDto {
  return {
    id: profile.id,
    areaId: profile.areaId,
    enabled: profile.enabled,
    persona: profile.persona,
    handoffMessage: profile.handoffMessage,
    model: profile.model,
    classifierModel: profile.classifierModel,
    timeoutMs: profile.timeoutMs,
    enabledActions: [...profile.enabledActions],
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function toAssistantIntentDto(intent: AssistantIntent): AssistantIntentDto {
  return {
    id: intent.id,
    profileId: intent.profileId,
    name: intent.name,
    description: intent.description,
    examples: [...intent.examples],
    enabled: intent.enabled,
    dataSourceKeys: [...intent.dataSourceKeys],
    responseGuide: intent.responseGuide,
    actionKey: intent.actionKey,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

/** `updatedAt` del catálogo NO se expone: al FE no le aporta y es ruido de contrato. */
export function toAssistantDataSourceDto(entry: AssistantDataSourceEntry): AssistantDataSourceDto {
  return { key: entry.key, label: entry.label, enabled: entry.enabled };
}

export function toAssistantActionDto(entry: AssistantActionEntry): AssistantActionDto {
  return { key: entry.key, label: entry.label, riskLevel: entry.riskLevel };
}
