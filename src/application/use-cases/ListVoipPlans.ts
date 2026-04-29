import { VozRepository } from '@domain/ports/VozRepository';
import { VoipPlan } from '@domain/entities/voz';

export class ListVoipPlans {
  constructor(private readonly repo: VozRepository) {}

  execute(): Promise<VoipPlan[]> {
    return this.repo.listVoipPlans();
  }
}
