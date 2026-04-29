import { Tr069Profile } from '@domain/entities/tr069';
import { Tr069Repository } from '@domain/ports/Tr069Repository';

export class UpdateTr069Profile {
  constructor(private readonly repo: Tr069Repository) {}

  async execute(id: string, data: Partial<Tr069Profile>) {
    return this.repo.updateProfile(id, data);
  }
}
