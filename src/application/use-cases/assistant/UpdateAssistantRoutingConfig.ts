import type {
  AssistantRoutingConfig,
  AssistantRoutingConfigRepository,
} from '@domain/ports/AssistantRoutingConfigRepository';
import type { AssistantProfileRepository } from '@domain/ports/AssistantProfileRepository';
import { AssistantDefaultAreaWithoutAgentError } from '@domain/errors/assistant';

/**
 * ai-assistant-multiagent (RTR-0) — define qué área atiende lo que entra sin clasificar.
 *
 * **Ésta es la perilla que hace que el asistente exista.** Sin un área default, el motor
 * resuelve `no_area_no_default` y hace no-op en todas las conversaciones, porque
 * `Conversation.areaId` entra siempre en NULL.
 *
 * Valida que el área tenga agente ANTES de guardar. Sin esa validación, apuntar a un área sin
 * agente se guarda perfecto, la pantalla muestra el ruteo "configurado", y el bot no responde
 * nunca — el motor busca el perfil, no lo encuentra y calla. Un 400 accionable ahora vale más
 * que un silencio inexplicable durante semanas.
 *
 * Apagar (`defaultAreaId: null`) NO valida nada: si validáramos también al apagar, borrar un
 * agente te dejaría sin forma de desactivar el ruteo. La salida siempre tiene que estar libre.
 */
export class UpdateAssistantRoutingConfig {
  constructor(
    private readonly repo: AssistantRoutingConfigRepository,
    private readonly profiles: AssistantProfileRepository,
  ) {}

  async execute(config: AssistantRoutingConfig): Promise<AssistantRoutingConfig> {
    if (config.defaultAreaId !== null) {
      const profile = await this.profiles.findByAreaId(config.defaultAreaId);
      if (!profile) throw new AssistantDefaultAreaWithoutAgentError(config.defaultAreaId);
    }

    return this.repo.update(config);
  }
}
