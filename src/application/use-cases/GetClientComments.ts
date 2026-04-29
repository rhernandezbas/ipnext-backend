import { ClientCommentRepository } from '@domain/ports/ClientCommentRepository';
import { ClientComment } from '@domain/entities/customer';

export class GetClientComments {
  constructor(private readonly repo: ClientCommentRepository) {}

  execute(clientId: string): Promise<ClientComment[]> {
    return this.repo.findByClientId(clientId);
  }
}
