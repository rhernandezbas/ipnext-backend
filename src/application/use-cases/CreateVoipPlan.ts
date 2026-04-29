import { VozRepository } from '@domain/ports/VozRepository';
import { VoipPlan } from '@domain/entities/voz';

export class CreateVoipPlan {
  constructor(private readonly repo: VozRepository) {}

  execute(data: Omit<VoipPlan, 'id'>): Promise<VoipPlan> {
    return this.repo.createVoipPlan(data);
  }
}
