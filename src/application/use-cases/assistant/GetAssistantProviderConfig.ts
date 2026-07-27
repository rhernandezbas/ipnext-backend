import {
  resolveProviderCredentials,
  type AssistantProviderConfigRepository,
} from '@domain/ports/AssistantProviderConfigRepository';
import {
  toAssistantProviderConfigDto,
  type AssistantProviderConfigDto,
} from '@application/dto/assistantProvider.dto';

/**
 * ai-assistant-multiagent — lee las credenciales del proveedor, ENMASCARADAS.
 *
 * Devuelve el DTO, jamás la entidad: la entidad tiene la key en claro y esto viaja al
 * navegador de cualquiera que abra la pantalla de configuración.
 */
export class GetAssistantProviderConfig {
  constructor(
    private readonly repo: AssistantProviderConfigRepository,
    private readonly envCredentials: { baseUrl: string; apiKey: string },
  ) {}

  async execute(): Promise<AssistantProviderConfigDto> {
    const stored = await this.repo.get();
    return toAssistantProviderConfigDto(stored, resolveProviderCredentials(stored, this.envCredentials));
  }
}
