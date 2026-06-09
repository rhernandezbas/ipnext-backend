import { ServicePlan, NetworkDevice } from '../entities/empresa';

export interface EmpresaRepository {
  // ServicePlan
  findAllServicePlans(subtype?: string): Promise<ServicePlan[]>;
  findServicePlanById(id: string): Promise<ServicePlan | null>;
  createServicePlan(data: Omit<ServicePlan, 'id'>): Promise<ServicePlan>;
  updateServicePlan(id: string, data: Partial<ServicePlan>): Promise<ServicePlan | null>;
  deleteServicePlan(id: string): Promise<boolean>;

  // NetworkDevice
  findAllNetworkDevices(): Promise<NetworkDevice[]>;
  findNetworkDeviceById(id: string): Promise<NetworkDevice | null>;
  createNetworkDevice(data: Omit<NetworkDevice, 'id'>): Promise<NetworkDevice>;
  updateNetworkDevice(id: string, data: Partial<NetworkDevice>): Promise<NetworkDevice | null>;
  deleteNetworkDevice(id: string): Promise<boolean>;
}
