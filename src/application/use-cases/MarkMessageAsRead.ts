import { MessageRepository } from '@domain/ports/MessageRepository';
import { Message } from '@domain/entities/message';

export class MarkMessageAsRead {
  constructor(private readonly repo: MessageRepository) {}

  execute(id: string): Promise<Message | null> {
    return this.repo.markAsRead(id);
  }
}
