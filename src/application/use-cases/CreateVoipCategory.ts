import { VozRepository } from '@domain/ports/VozRepository';
import { VoipCategory } from '@domain/entities/voz';

export class CreateVoipCategory {
  constructor(private readonly repo: VozRepository) {}

  execute(data: Omit<VoipCategory, 'id'>): Promise<VoipCategory> {
    return this.repo.createVoipCategory(data);
  }
}
