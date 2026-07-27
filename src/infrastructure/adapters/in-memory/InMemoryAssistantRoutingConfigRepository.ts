import {
  ASSISTANT_ROUTING_DEFAULTS,
  type AssistantRoutingConfig,
  type AssistantRoutingConfigRepository,
} from '@domain/ports/AssistantRoutingConfigRepository';

/** ai-assistant-multiagent (RTR-0) — ruteo en memoria. Espeja el contrato del adapter Prisma. */
export class InMemoryAssistantRoutingConfigRepository implements AssistantRoutingConfigRepository {
  private config: AssistantRoutingConfig | null = null;

  async get(): Promise<AssistantRoutingConfig> {
    return { ...(this.config ?? ASSISTANT_ROUTING_DEFAULTS) };
  }

  async update(config: AssistantRoutingConfig): Promise<AssistantRoutingConfig> {
    this.config = { ...config };
    return { ...this.config };
  }
}
