import type { TemplateAdminPort } from '@domain/ports/TemplateMessagingPort';
import type { TemplateDetailDto } from '@application/dto/messaging-templates.dto';
import { toTemplateDetailDto } from '@application/dto/messaging-templates.dto';

/**
 * Change 3 (templates CRUD) — VER la ficha de UN template. Delega en el port y
 * mapea a DTO curado. Si el proveedor no lo tiene (404), el port lanza
 * `TemplateNotFoundError` (la ruta lo mapea a 404) — este use case solo propaga.
 */
export class GetTemplate {
  constructor(private readonly adminPort: TemplateAdminPort) {}

  async execute(contentSid: string): Promise<TemplateDetailDto> {
    const template = await this.adminPort.getTemplate(contentSid);
    return toTemplateDetailDto(template);
  }
}
