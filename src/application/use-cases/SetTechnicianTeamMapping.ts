import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { IClassTeamRepository } from '@domain/ports/IClassTeamRepository';
import { RbacUser } from '@domain/entities/rbac';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';
import { IClassTeamNotAssignableError } from '@domain/errors/iclass';

export interface SetTechnicianTeamMappingInput {
  userId: string;
  /** null = desmapear (always allowed). string = must be active && selectable. */
  iclassTeamLogin: string | null;
}

/**
 * SetTechnicianTeamMapping — maps a technician (RbacUser) to an IClass team.
 *
 * Flow (AD-1):
 * 1. Resolve user — not found → ReferenceNotFoundError (404).
 * 2. If iclassTeamLogin != null → validate team exists + active + selectable,
 *    else → IClassTeamNotAssignableError (422).
 * 3. null → always allowed (desmapear).
 * 4. update(userId, { iclassTeamLogin }).
 */
export class SetTechnicianTeamMapping {
  constructor(
    private readonly userRepo: RbacUserRepository,
    private readonly teamRepo: IClassTeamRepository,
  ) {}

  async execute(input: SetTechnicianTeamMappingInput): Promise<RbacUser> {
    const { userId, iclassTeamLogin } = input;

    // Step 1: resolve user
    const user = await this.userRepo.findById(userId);
    if (!user) throw new ReferenceNotFoundError('user', userId);

    // Step 2: validate team (only when mapping, not when desmapping)
    if (iclassTeamLogin !== null) {
      const team = await this.teamRepo.getByLogin(iclassTeamLogin);
      if (!team) {
        throw new IClassTeamNotAssignableError(iclassTeamLogin, 'team not found in catalog');
      }
      if (!team.active) {
        throw new IClassTeamNotAssignableError(iclassTeamLogin, 'team is inactive');
      }
      if (!team.selectable) {
        throw new IClassTeamNotAssignableError(iclassTeamLogin, 'team is not selectable (grouping team)');
      }
    }

    // Step 3: persist
    return this.userRepo.update(userId, { iclassTeamLogin });
  }
}
