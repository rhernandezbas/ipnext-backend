import { IClassClosureConfigRepository } from '@domain/ports/IClassClosureConfigRepository';
import { IClassClosureConfigDTO, toIClassClosureConfigDTO } from '@application/dto/iclassClosure.dto';

/**
 * Returns the current IClass closure+autocomplete config as a DTO.
 * The repo returns defaults when no row has been persisted yet (spec scenario 4).
 */
export class GetIClassClosureConfig {
  constructor(private readonly config: IClassClosureConfigRepository) {}

  async execute(): Promise<IClassClosureConfigDTO> {
    const current = await this.config.get();
    return toIClassClosureConfigDTO(current);
  }
}
