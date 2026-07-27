import {
  ASSISTANT_PROVIDER_DEFAULTS,
  type AssistantProviderConfig,
  type AssistantProviderConfigRepository,
  type UpdateAssistantProviderConfigInput,
} from '@domain/ports/AssistantProviderConfigRepository';

/** Espeja el contrato del adapter Prisma, incluida la regla "vacío preserva". */
export class InMemoryAssistantProviderConfigRepository
  implements AssistantProviderConfigRepository
{
  private config: AssistantProviderConfig = { ...ASSISTANT_PROVIDER_DEFAULTS };

  async get(): Promise<AssistantProviderConfig> {
    return { ...this.config };
  }

  async update(input: UpdateAssistantProviderConfigInput): Promise<AssistantProviderConfig> {
    this.config = {
      baseUrl: input.baseUrl ?? this.config.baseUrl,
      apiKey: input.clearApiKey ? '' : input.apiKey ? input.apiKey : this.config.apiKey,
    };
    return { ...this.config };
  }
}
