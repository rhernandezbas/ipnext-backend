import type { AssistantProfileRepository } from '@domain/ports/AssistantProfileRepository';
import { AssistantProfileAlreadyExistsError } from '@domain/errors/assistant';
import { toAssistantProfileDto, type AssistantProfileDto } from '@application/dto/assistant.dto';

export interface CreateAssistantProfileCommand {
  areaId: string;
  persona?: string;
  handoffMessage?: string;
  model?: string;
  classifierModel?: string | null;
  timeoutMs?: number;
}

/**
 * ai-assistant-multiagent (CFG-1) — crea el perfil de agente de un área.
 *
 * El comando NO acepta `enabled` ni `enabledActions`: un perfil nace APAGADO y sin ninguna
 * capacidad de actuar. Habilitarlo es siempre un acto posterior, explícito y auditable
 * (`UpdateAssistantProfile`). La ausencia de configuración SIEMPRE resuelve a "no hablar".
 */
export class CreateAssistantProfile {
  constructor(private readonly profiles: AssistantProfileRepository) {}

  async execute(command: CreateAssistantProfileCommand): Promise<AssistantProfileDto> {
    // Chequeo explícito en vez de atrapar el P2002 del `@unique`: el error tipado es el
    // contrato (409), y no depende de qué código de error use el adapter de turno.
    const existing = await this.profiles.findByAreaId(command.areaId);
    if (existing) {
      throw new AssistantProfileAlreadyExistsError();
    }

    const profile = await this.profiles.create({
      areaId: command.areaId,
      persona: command.persona,
      handoffMessage: command.handoffMessage,
      model: command.model,
      classifierModel: command.classifierModel,
      timeoutMs: command.timeoutMs,
    });

    return toAssistantProfileDto(profile);
  }
}
