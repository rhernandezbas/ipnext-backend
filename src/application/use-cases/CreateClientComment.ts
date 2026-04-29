import { ClientCommentRepository } from '@domain/ports/ClientCommentRepository';
import { ClientComment } from '@domain/entities/customer';
import { randomUUID } from 'crypto';

export class CreateClientComment {
  constructor(private readonly repo: ClientCommentRepository) {}

  execute(clientId: string, content: string, authorName: string): Promise<ClientComment> {
    const comment: ClientComment = {
      id: randomUUID(),
      clientId,
      authorName,
      content,
      createdAt: new Date().toISOString(),
    };
    return this.repo.create(comment);
  }
}
