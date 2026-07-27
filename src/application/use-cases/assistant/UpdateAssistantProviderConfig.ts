import {
  resolveProviderCredentials,
  type AssistantProviderConfigRepository,
  type UpdateAssistantProviderConfigInput,
} from '@domain/ports/AssistantProviderConfigRepository';
import {
  toAssistantProviderConfigDto,
  type AssistantProviderConfigDto,
} from '@application/dto/assistantProvider.dto';

/**
 * ai-assistant-multiagent — guarda las credenciales del proveedor.
 *
 * Devuelve el DTO ENMASCARADO: ni siquiera el response de un PUT exitoso repite la key que
 * acabás de mandar. Devolverla "porque el cliente ya la tiene" es cómo termina en un log de
 * red, en un cache del browser o en una captura de pantalla.
 */
export class UpdateAssistantProviderConfig {
  constructor(
    private readonly repo: AssistantProviderConfigRepository,
    private readonly envCredentials: { baseUrl: string; apiKey: string },
  ) {}

  async execute(input: UpdateAssistantProviderConfigInput): Promise<AssistantProviderConfigDto> {
    const stored = await this.repo.update(input);
    return toAssistantProviderConfigDto(stored, resolveProviderCredentials(stored, this.envCredentials));
  }
}
