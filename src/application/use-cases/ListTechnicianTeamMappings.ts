import { RbacUserRepository, RbacUserWithTeam } from '@domain/ports/RbacUserRepository';

export interface TechnicianTeamMappingDTO {
  userId: string;
  userName: string;
  userLogin: string;
  iclassTeamLogin: string | null;
  teamName: string | null;
  teamActive: boolean;
}

/**
 * ListTechnicianTeamMappings — returns all technicians with their IClass team mapping.
 * Delegates to listWithIClassTeam (AD-4) which does the join in the adapter.
 */
export class ListTechnicianTeamMappings {
  constructor(private readonly userRepo: RbacUserRepository) {}

  async execute(): Promise<TechnicianTeamMappingDTO[]> {
    const users: RbacUserWithTeam[] = await this.userRepo.listWithIClassTeam();
    return users.map(u => ({
      userId: u.id,
      userName: u.name,
      userLogin: u.login,
      iclassTeamLogin: u.iclassTeamLogin,
      teamName: u.teamName,
      teamActive: u.teamActive,
    }));
  }
}
