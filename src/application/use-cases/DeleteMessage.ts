import { MessageRepository } from '@domain/ports/MessageRepository';

export class DeleteMessage {
  constructor(private readonly repo: MessageRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
