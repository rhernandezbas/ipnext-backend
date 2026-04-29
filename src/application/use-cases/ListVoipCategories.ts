import { VozRepository } from '@domain/ports/VozRepository';
import { VoipCategory } from '@domain/entities/voz';

export class ListVoipCategories {
  constructor(private readonly repo: VozRepository) {}

  execute(): Promise<VoipCategory[]> {
    return this.repo.listVoipCategories();
  }
}
