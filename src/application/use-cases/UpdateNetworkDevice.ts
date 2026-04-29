import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { NetworkDevice } from '@domain/entities/empresa';

export class UpdateNetworkDevice {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string, data: Partial<NetworkDevice>): Promise<NetworkDevice | null> {
    return this.repo.updateNetworkDevice(id, data);
  }
}
