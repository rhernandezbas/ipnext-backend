import type {
  AssistantIntentRepository,
  AssistantProfileRepository,
} from '@domain/ports/AssistantProfileRepository';
import { AssistantProfileNotFoundError } from '@domain/errors/assistant';
import {
  toAssistantIntentDto,
  toAssistantProfileDto,
  type AssistantIntentDto,
  type AssistantProfileDto,
} from '@application/dto/assistant.dto';

export interface AssistantProfileWithIntentsDto extends AssistantProfileDto {
  intents: AssistantIntentDto[];
}

/**
 * ai-assistant-multiagent (CFG-1/CFG-2) — lecturas de la configuración.
 *
 * `getByAreaId` devuelve `null` (no lanza) cuando el área no tiene perfil: es el caso normal
 * —la mayoría de las áreas no van a tener agente— y el FE necesita distinguir "no configurado"
 * de "error". `getById` sí lanza 404, porque ahí el id vino de una URL explícita.
 *
 * Las intenciones viajan SIEMPRE con el perfil (habilitadas y apagadas): el editor necesita
 * ver las apagadas para poder prenderlas, y traerlas en dos requests sólo abriría la puerta a
 * que la pantalla muestre un estado inconsistente.
 */
export class GetAssistantConfig {
  constructor(
    private readonly profiles: AssistantProfileRepository,
    private readonly intents: AssistantIntentRepository,
  ) {}

  async getById(id: string): Promise<AssistantProfileWithIntentsDto> {
    const profile = await this.profiles.findById(id);
    if (!profile) {
      throw new AssistantProfileNotFoundError();
    }
    return this.withIntents(profile.id, toAssistantProfileDto(profile));
  }

  async getByAreaId(areaId: string): Promise<AssistantProfileWithIntentsDto | null> {
    const profile = await this.profiles.findByAreaId(areaId);
    if (!profile) return null;
    return this.withIntents(profile.id, toAssistantProfileDto(profile));
  }

  /** Lista de perfiles SIN intenciones — es la vista de índice, no el editor. */
  async list(): Promise<AssistantProfileDto[]> {
    const profiles = await this.profiles.list();
    return profiles.map(toAssistantProfileDto);
  }

  private async withIntents(
    profileId: string,
    dto: AssistantProfileDto,
  ): Promise<AssistantProfileWithIntentsDto> {
    const intents = await this.intents.listByProfileId(profileId);
    return { ...dto, intents: intents.map(toAssistantIntentDto) };
  }
}
