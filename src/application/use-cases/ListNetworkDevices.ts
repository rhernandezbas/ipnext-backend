import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { NetworkDevice } from '@domain/entities/empresa';

export class ListNetworkDevices {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(): Promise<NetworkDevice[]> {
    return this.repo.findAllNetworkDevices();
  }
}
