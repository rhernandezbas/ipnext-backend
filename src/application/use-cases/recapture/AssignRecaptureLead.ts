import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { UserRoleLookup } from '@domain/ports/UserRoleLookup';
import { RecaptureLeadNotFoundError, RecaptureAssigneeNotAllowedError } from '@domain/errors/recapture';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';
import { isTechnicalRoleSet } from '@domain/entities/rbac';
import { RecaptureLeadDto, toRecaptureLeadDto } from '@application/dto/recapture/recapture.dto';

export class AssignRecaptureLead {
  constructor(
    private readonly repo: RecaptureRepository,
    private readonly userLookup: EntityLookup,
    private readonly roleLookup: UserRoleLookup,
  ) {}

  /**
   * Unconditionally assigns a lead to `operatorId`, overwriting any current assignee.
   * - operatorId non-null: validate user exists AND is an allowed assignee, then
   *   assign (status → en_gestion).
   * - operatorId null:     unassign (status → nuevo, claimedAt cleared) — no checks.
   *
   * Assignable = active user WITH at least one role AND none technical. The
   * existence check runs FIRST, so a ghost id yields ReferenceNotFoundError
   * (not the pool error).
   *
   * Throws RecaptureLeadNotFoundError if the lead does not exist.
   * Throws ReferenceNotFoundError('assignee', operatorId) if the operator does not exist.
   * Throws RecaptureAssigneeNotAllowedError if the operator is not an allowed assignee.
   */
  async execute(leadId: string, operatorId: string | null): Promise<RecaptureLeadDto> {
    if (operatorId !== null) {
      const user = await this.userLookup.findById(operatorId);
      if (!user) throw new ReferenceNotFoundError('assignee', operatorId);

      const codes = await this.roleLookup.listRoleCodes(operatorId);
      if (!(codes.length > 0 && !isTechnicalRoleSet(codes))) {
        throw new RecaptureAssigneeNotAllowedError(operatorId);
      }
    }

    const lead = await this.repo.assign(leadId, operatorId);
    if (!lead) throw new RecaptureLeadNotFoundError(leadId);

    return toRecaptureLeadDto(lead);
  }
}
