import { Tr069Repository } from '@domain/ports/Tr069Repository';

export class ListTr069Profiles {
  constructor(private readonly repo: Tr069Repository) {}

  async execute() {
    return this.repo.findAllProfiles();
  }
}
