import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { UserRoleLookup } from '@domain/ports/UserRoleLookup';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';
import { RecaptureAssigneeNotAllowedError } from '@domain/errors/recapture';
import { isTechnicalRoleSet } from '@domain/entities/rbac';

export class AssignRecaptureLeadsBulk {
  constructor(
    private readonly repo: RecaptureRepository,
    private readonly userLookup: EntityLookup,
    private readonly roleLookup: UserRoleLookup,
  ) {}

  async execute(leadIds: string[], operatorId: string | null): Promise<{ assigned: number }> {
    // Assignee validation runs ONCE, before the loop: existence first, then the
    // assignee-pool rule (active + ≥1 role + none technical). A non-assignable
    // target aborts the whole operation with NO lead mutated.
    if (operatorId !== null) {
      const user = await this.userLookup.findById(operatorId);
      if (!user) throw new ReferenceNotFoundError('assignee', operatorId);

      const codes = await this.roleLookup.listRoleCodes(operatorId);
      if (!(codes.length > 0 && !isTechnicalRoleSet(codes))) {
        throw new RecaptureAssigneeNotAllowedError(operatorId);
      }
    }

    let assigned = 0;
    for (const leadId of leadIds) {
      const result = await this.repo.assign(leadId, operatorId);
      if (result !== null) assigned++;
    }

    return { assigned };
  }
}
