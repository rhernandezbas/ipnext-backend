import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { RecaptureLeadNotFoundError } from '@domain/errors/recapture';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';
import { RecaptureLeadDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';

export class AssignRecaptureLead {
  constructor(
    private readonly repo: RecaptureRepository,
    private readonly userLookup: EntityLookup,
  ) {}

  /**
   * Unconditionally assigns a lead to `operatorId`, overwriting any current assignee.
   * - operatorId non-null: validate user exists, then assign (status → en_gestion).
   * - operatorId null:     unassign (status → nuevo, claimedAt cleared).
   *
   * Throws RecaptureLeadNotFoundError if the lead does not exist.
   * Throws ReferenceNotFoundError('assignee', operatorId) if the operator does not exist.
   */
  async execute(leadId: string, operatorId: string | null): Promise<RecaptureLeadDto> {
    if (operatorId !== null) {
      const user = await this.userLookup.findById(operatorId);
      if (!user) throw new ReferenceNotFoundError('assignee', operatorId);
    }

    const lead = await this.repo.assign(leadId, operatorId);
    if (!lead) throw new RecaptureLeadNotFoundError(leadId);

    return toRecaptureLeadDto(lead);
  }
}
