import type { TemplateAdminPort, CreateTemplateInput as ProviderCreateTemplateInput } from '@domain/ports/TemplateMessagingPort';
import type { CreateTemplateInput, TemplateDetailDto } from '@application/dto/messaging-templates.dto';
import { toTemplateDetailDto, isTemplateCategory } from '@application/dto/messaging-templates.dto';
import { InvalidTemplateInputError } from '@domain/errors/messaging-bulk';

/**
 * Change 3 (templates CRUD) — CREAR un template directo a Twilio Content API.
 * Valida la entrada del operador (friendlyName/language/body no vacíos, category
 * ∈ enum si viene), mapea `variables[]` (nombres declarados) al `Record`
 * índice→sample que espera el proveedor, y devuelve un DTO CURADO (nunca el JSON
 * crudo de Twilio). Depende del PORT (`TemplateAdminPort`), jamás de Twilio/axios.
 *
 * Nota: `category` NO viaja al POST de creación (Twilio la fija recién al SUBMIT);
 * acá solo se valida para fallar temprano ante un fat-finger.
 */
export class CreateTemplate {
  constructor(private readonly adminPort: TemplateAdminPort) {}

  async execute(input: CreateTemplateInput): Promise<TemplateDetailDto> {
    const friendlyName = (input.friendlyName ?? '').trim();
    if (!friendlyName) throw new InvalidTemplateInputError('friendlyName es requerido');

    const language = (input.language ?? '').trim();
    if (!language) throw new InvalidTemplateInputError('language es requerido');

    if (!input.body || input.body.trim() === '') {
      throw new InvalidTemplateInputError('body es requerido');
    }

    if (input.category !== undefined && !isTemplateCategory(input.category)) {
      throw new InvalidTemplateInputError(`category inválida: ${input.category}`);
    }

    // `variables[]` (nombres/índices declarados) → Record índice→sample. Twilio
    // usa `variables` como valores de EJEMPLO; sin datos reales usamos el propio
    // nombre como sample (determinístico y suficiente para el preview de Meta).
    const variables: Record<string, string> = {};
    for (const name of input.variables ?? []) {
      variables[name] = name;
    }

    const providerInput: ProviderCreateTemplateInput = {
      friendlyName,
      language,
      variables,
      body: input.body,
    };
    const created = await this.adminPort.createTemplate(providerInput);
    return toTemplateDetailDto(created);
  }
}
