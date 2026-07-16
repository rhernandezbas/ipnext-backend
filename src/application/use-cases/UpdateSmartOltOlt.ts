import {
  SmartOltOltConfig,
  SmartOltOltConfigRepository,
  UpdateSmartOltOltConfigInput,
} from '@domain/ports/SmartOltOltConfigRepository';
import { SmartOltOltConfigNotFoundError } from '@domain/errors/smartolt';

/**
 * smartolt-provision (K2) — PUT /api/fiber/olts/:id. Patch parcial del catálogo
 * (name / serviceVlanDefault / mgmtVlan). Semántica nullable del port: campo
 * OMITIDO = mantener; `null` explícito = limpiar (CHIVILCOY vive con default null).
 */
export class UpdateSmartOltOlt {
  constructor(private readonly repo: SmartOltOltConfigRepository) {}

  async execute(id: string, patch: UpdateSmartOltOltConfigInput): Promise<SmartOltOltConfig> {
    const updated = await this.repo.update(id, patch);
    if (!updated) throw new SmartOltOltConfigNotFoundError(id);
    return updated;
  }
}
