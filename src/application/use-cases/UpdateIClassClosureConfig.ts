import { IClassClosureConfigRepository } from '@domain/ports/IClassClosureConfigRepository';
import {
  IClassClosureConfigDTO,
  UpdateIClassClosureConfigInput,
  toIClassClosureConfigDTO,
} from '@application/dto/iclassClosure.dto';

/**
 * Applies a validated partial patch to the IClass closure+autocomplete config.
 * Body-shape validation (e.g. `closureIntervalMs: "soon"`, below 60000) is the
 * route's job via the Zod schema (400 VALIDATION_ERROR); this use-case receives
 * an already-parsed, type-safe patch.
 */
export class UpdateIClassClosureConfig {
  constructor(private readonly config: IClassClosureConfigRepository) {}

  async execute(patch: UpdateIClassClosureConfigInput): Promise<IClassClosureConfigDTO> {
    const updated = await this.config.update(patch);
    return toIClassClosureConfigDTO(updated);
  }
}
