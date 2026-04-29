import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { NetworkDevice } from '@domain/entities/empresa';

export class CreateNetworkDevice {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(data: Omit<NetworkDevice, 'id'>): Promise<NetworkDevice> {
    return this.repo.createNetworkDevice(data);
  }
}
