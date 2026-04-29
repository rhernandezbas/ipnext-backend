import { ServicePlan, NetworkDevice, InventoryItem, InventoryProduct, InventoryUnit } from '../entities/empresa';

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

  // InventoryItem (legacy catalog — kept for backward compat)
  findAllInventoryItems(): Promise<InventoryItem[]>;
  findInventoryItemById(id: string): Promise<InventoryItem | null>;
  createInventoryItem(data: Omit<InventoryItem, 'id'>): Promise<InventoryItem>;
  updateInventoryItem(id: string, data: Partial<InventoryItem>): Promise<InventoryItem | null>;
  deleteInventoryItem(id: string): Promise<boolean>;

  // InventoryProduct (catalog)
  findAllInventoryProducts(): Promise<InventoryProduct[]>;
  findInventoryProductById(id: string): Promise<InventoryProduct | null>;
  updateInventoryProduct(id: string, data: Partial<InventoryProduct>): Promise<InventoryProduct | null>;
  deleteInventoryProduct(id: string): Promise<boolean>;

  // InventoryUnit (physical units)
  findAllInventoryUnits(): Promise<InventoryUnit[]>;
  findInventoryUnitsByProductId(productId: string): Promise<InventoryUnit[]>;
  createInventoryUnit(data: Omit<InventoryUnit, 'id'>): Promise<InventoryUnit>;
  updateInventoryUnit(id: string, data: Partial<InventoryUnit>): Promise<InventoryUnit | null>;
  deleteInventoryUnit(id: string): Promise<boolean>;
}
