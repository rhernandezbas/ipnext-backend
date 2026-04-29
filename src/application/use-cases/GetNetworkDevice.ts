import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { NetworkDevice } from '@domain/entities/empresa';

export class GetNetworkDevice {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string): Promise<NetworkDevice | null> {
    return this.repo.findNetworkDeviceById(id);
  }
}
