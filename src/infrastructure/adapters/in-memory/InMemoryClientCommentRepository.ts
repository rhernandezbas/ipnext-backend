import { ClientCommentRepository } from '@domain/ports/ClientCommentRepository';
import { ClientComment } from '@domain/entities/customer';

export class InMemoryClientCommentRepository implements ClientCommentRepository {
  private readonly store = new Map<string, ClientComment[]>();

  async findByClientId(clientId: string): Promise<ClientComment[]> {
    return this.store.get(clientId) ?? [];
  }

  async create(comment: ClientComment): Promise<ClientComment> {
    const existing = this.store.get(comment.clientId) ?? [];
    existing.push(comment);
    this.store.set(comment.clientId, existing);
    return comment;
  }
}
