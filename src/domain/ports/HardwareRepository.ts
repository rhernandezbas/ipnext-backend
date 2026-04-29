import { HardwareAsset } from '../entities/hardware';

export interface HardwareRepository {
  findAll(): Promise<HardwareAsset[]>;
  create(data: Omit<HardwareAsset, 'id'>): Promise<HardwareAsset>;
  update(id: string, data: Partial<HardwareAsset>): Promise<HardwareAsset | null>;
  delete(id: string): Promise<boolean>;
}
