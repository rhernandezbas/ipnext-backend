import { RecaptureRepository } from '@domain/ports/RecaptureRepository';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

export class AssignRecaptureLeadsBulk {
  constructor(
    private readonly repo: RecaptureRepository,
    private readonly userLookup: EntityLookup,
  ) {}

  async execute(leadIds: string[], operatorId: string | null): Promise<{ assigned: number }> {
    if (operatorId !== null) {
      const user = await this.userLookup.findById(operatorId);
      if (!user) throw new ReferenceNotFoundError('assignee', operatorId);
    }

    let assigned = 0;
    for (const leadId of leadIds) {
      const result = await this.repo.assign(leadId, operatorId);
      if (result !== null) assigned++;
    }

    return { assigned };
  }
}
