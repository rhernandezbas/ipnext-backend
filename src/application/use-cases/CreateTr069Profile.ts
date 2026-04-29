import { Tr069Profile } from '@domain/entities/tr069';
import { Tr069Repository } from '@domain/ports/Tr069Repository';

export class CreateTr069Profile {
  constructor(private readonly repo: Tr069Repository) {}

  async execute(data: Omit<Tr069Profile, 'id'>) {
    return this.repo.createProfile(data);
  }
}
