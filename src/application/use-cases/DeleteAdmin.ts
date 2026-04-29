import { AdminRepository } from '@domain/ports/AdminRepository';

export class DeleteAdmin {
  constructor(private readonly repo: AdminRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
