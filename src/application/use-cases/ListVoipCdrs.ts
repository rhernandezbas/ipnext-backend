import { VozRepository } from '@domain/ports/VozRepository';
import { VoipCdr } from '@domain/entities/voz';

export class ListVoipCdrs {
  constructor(private readonly repo: VozRepository) {}

  execute(): Promise<VoipCdr[]> {
    return this.repo.listVoipCdrs();
  }
}
