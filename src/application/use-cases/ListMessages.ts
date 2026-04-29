import { MessageRepository } from '@domain/ports/MessageRepository';
import { Message } from '@domain/entities/message';

export class ListMessages {
  constructor(private readonly repo: MessageRepository) {}

  execute(filter?: 'inbox' | 'sent' | 'draft'): Promise<Message[]> {
    return this.repo.findAll(filter);
  }
}
