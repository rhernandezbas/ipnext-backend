import { MessageRepository } from '@domain/ports/MessageRepository';
import { Message } from '@domain/entities/message';

export class CreateMessage {
  constructor(private readonly repo: MessageRepository) {}

  execute(data: Omit<Message, 'id' | 'createdAt'>): Promise<Message> {
    return this.repo.create(data);
  }
}
