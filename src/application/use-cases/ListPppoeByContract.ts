import { PppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';

/** Lista los PPPoE de un contrato (N por contrato — un cliente puede tener varios). */
export class ListPppoeByContract {
  constructor(private readonly repo: PppoeServiceRepository) {}

  async execute(contractId: string): Promise<PppoeService[]> {
    return this.repo.findByContract(contractId);
  }
}
