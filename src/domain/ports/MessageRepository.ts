import { Message, MessageStatus } from '@domain/entities/message';

export interface MessageRepository {
  findAll(filter?: 'inbox' | 'sent' | 'draft'): Promise<Message[]>;
  findById(id: string): Promise<Message | null>;
  create(data: Omit<Message, 'id' | 'createdAt'>): Promise<Message>;
  markAsRead(id: string): Promise<Message | null>;
  delete(id: string): Promise<boolean>;
}
