import type {
  AssistantRoutingConfig,
  AssistantRoutingConfigRepository,
} from '@domain/ports/AssistantRoutingConfigRepository';

/**
 * ai-assistant-multiagent (RTR-0) — lee a quién le toca lo que entra sin clasificar.
 *
 * `defaultAreaId: null` no es "todavía no configuraron esto": es un estado OPERATIVO con
 * consecuencia concreta — nadie atiende las conversaciones sin área, que en la práctica son
 * TODAS (los agentes trabajan en Chatwoot y nadie clasifica desde Prominense). La pantalla
 * tiene que decirlo con esas palabras, no mostrarlo como un campo vacío más.
 *
 * No hay nada que enmascarar acá: son dos campos de configuración, sin secretos.
 */
export class GetAssistantRoutingConfig {
  constructor(private readonly repo: AssistantRoutingConfigRepository) {}

  async execute(): Promise<AssistantRoutingConfig> {
    return this.repo.get();
  }
}
