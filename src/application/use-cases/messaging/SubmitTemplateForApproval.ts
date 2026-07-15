import type { TemplateAdminPort } from '@domain/ports/TemplateMessagingPort';
import type { SubmitTemplateInput } from '@application/dto/messaging-templates.dto';
import { isTemplateCategory } from '@application/dto/messaging-templates.dto';
import { InvalidTemplateInputError } from '@domain/errors/messaging-bulk';

/**
 * Normaliza un nombre de template al formato que exige Meta/WhatsApp: minúsculas,
 * solo `[a-z0-9_]`, sin underscores de borde. Ej: `'Recordatorio DEUDA #1'` →
 * `'recordatorio_deuda_1'`.
 */
export function normalizeTemplateName(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Change 3 (templates CRUD) — SUBMIT de un template a Meta para aprobación.
 * Valida `category` ∈ {UTILITY, MARKETING, AUTHENTICATION} y normaliza el `name`
 * antes de llamar al port. Falla temprano (400) sin tocar el proveedor si algo
 * es inválido. Meta NO deja editar un template submitted/aprobado — "editar
 * aprobado" = clonar (nuevo CreateTemplate) + re-submit; NO se expone PUT.
 */
export class SubmitTemplateForApproval {
  constructor(private readonly adminPort: TemplateAdminPort) {}

  async execute(contentSid: string, input: SubmitTemplateInput): Promise<void> {
    if (!isTemplateCategory(input.category)) {
      throw new InvalidTemplateInputError(
        `category inválida: ${input.category} (esperado UTILITY | MARKETING | AUTHENTICATION)`,
      );
    }

    const name = normalizeTemplateName(input.name);
    if (!name) throw new InvalidTemplateInputError('name es requerido');

    await this.adminPort.submitForApproval(contentSid, name, input.category);
  }
}
