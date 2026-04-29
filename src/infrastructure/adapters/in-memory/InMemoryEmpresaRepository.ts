import { ServicePlan, NetworkDevice, InventoryItem, InventoryProduct, InventoryUnit } from '@domain/entities/empresa';
import { EmpresaRepository } from '@domain/ports/EmpresaRepository';

let nextServicePlanId = 13;
let nextNetworkDeviceId = 6;
let nextInventoryItemId = 6;
let nextInventoryUnitId = 11;

export class InMemoryEmpresaRepository implements EmpresaRepository {
  private servicePlans: ServicePlan[] = [
    {
      id: '1',
      name: 'Plan Básico',
      type: 'internet',
      planSubtype: 'internet',
      downloadSpeed: 25,
      uploadSpeed: 10,
      price: 3500,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Internet hasta 25 Mbps',
      subscriberCount: 234,
    },
    {
      id: '2',
      name: 'Plan Estándar',
      type: 'internet',
      planSubtype: 'internet',
      downloadSpeed: 100,
      uploadSpeed: 50,
      price: 6500,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Internet hasta 100 Mbps',
      subscriberCount: 512,
    },
    {
      id: '3',
      name: 'Plan Premium',
      type: 'internet',
      planSubtype: 'internet',
      downloadSpeed: 300,
      uploadSpeed: 150,
      price: 12000,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Internet hasta 300 Mbps',
      subscriberCount: 189,
    },
    {
      id: '4',
      name: 'VoIP Básico',
      type: 'voip',
      planSubtype: 'voice',
      downloadSpeed: 0,
      uploadSpeed: 0,
      price: 2000,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Servicio VoIP básico',
      subscriberCount: 45,
    },
    {
      id: '5',
      name: 'VoIP Premium',
      type: 'voip',
      planSubtype: 'voice',
      downloadSpeed: 0,
      uploadSpeed: 0,
      price: 4500,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Servicio VoIP premium con líneas ilimitadas',
      subscriberCount: 28,
    },
    {
      id: '6',
      name: 'Soporte Técnico Mensual',
      type: 'other',
      planSubtype: 'recurring',
      downloadSpeed: 0,
      uploadSpeed: 0,
      price: 1500,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Soporte técnico mensual incluido',
      subscriberCount: 120,
    },
    {
      id: '7',
      name: 'Seguro de Equipo',
      type: 'other',
      planSubtype: 'recurring',
      downloadSpeed: 0,
      uploadSpeed: 0,
      price: 800,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Seguro mensual para equipos en comodato',
      subscriberCount: 89,
    },
    {
      id: '8',
      name: 'Instalación Básica',
      type: 'other',
      planSubtype: 'onetime',
      downloadSpeed: 0,
      uploadSpeed: 0,
      price: 3000,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Instalación estándar de fibra óptica',
      subscriberCount: 0,
    },
    {
      id: '9',
      name: 'Instalación Premium',
      type: 'other',
      planSubtype: 'onetime',
      downloadSpeed: 0,
      uploadSpeed: 0,
      price: 6000,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Instalación premium con cableado interior incluido',
      subscriberCount: 0,
    },
    {
      id: '10',
      name: 'Paquete Internet + Voz Básico',
      type: 'other',
      planSubtype: 'bundle',
      downloadSpeed: 100,
      uploadSpeed: 50,
      price: 7500,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Internet 100 Mbps + VoIP básico',
      subscriberCount: 67,
    },
    {
      id: '11',
      name: 'Paquete Internet + Voz + TV',
      type: 'tv',
      planSubtype: 'bundle',
      downloadSpeed: 300,
      uploadSpeed: 150,
      price: 15000,
      billingCycle: 'monthly',
      status: 'active',
      description: 'Internet 300 Mbps + VoIP premium + TV digital',
      subscriberCount: 34,
    },
    {
      id: '12',
      name: 'Plan Ultra',
      type: 'internet',
      planSubtype: 'internet',
      downloadSpeed: 1000,
      uploadSpeed: 500,
      price: 25000,
      billingCycle: 'monthly',
      status: 'inactive',
      description: 'Internet hasta 1 Gbps simétrico',
      subscriberCount: 12,
    },
  ];

  private networkDevices: NetworkDevice[] = [
    {
      id: '1',
      name: 'OLT Central',
      type: 'olt',
      ipAddress: '192.168.1.1',
      macAddress: 'AA:BB:CC:DD:EE:01',
      location: 'Data Center Principal',
      status: 'online',
      model: 'Huawei MA5800-X7',
      lastSeen: '2026-04-28T08:00:00Z',
    },
    {
      id: '2',
      name: 'Router Core',
      type: 'router',
      ipAddress: '192.168.1.2',
      macAddress: 'AA:BB:CC:DD:EE:02',
      location: 'Data Center Principal',
      status: 'online',
      model: 'MikroTik CCR2004',
      lastSeen: '2026-04-28T08:01:00Z',
    },
    {
      id: '3',
      name: 'Switch Distribución',
      type: 'switch',
      ipAddress: '192.168.1.3',
      macAddress: 'AA:BB:CC:DD:EE:03',
      location: 'Planta Baja',
      status: 'warning',
      model: 'Cisco SG350-28',
      lastSeen: '2026-04-28T07:45:00Z',
    },
    {
      id: '4',
      name: 'Access Point Zona Norte',
      type: 'access_point',
      ipAddress: '192.168.2.10',
      macAddress: 'AA:BB:CC:DD:EE:04',
      location: 'Zona Norte',
      status: 'online',
      model: 'Ubiquiti UAP-AC-Pro',
      lastSeen: '2026-04-28T08:02:00Z',
    },
    {
      id: '5',
      name: 'ONU Cliente 001',
      type: 'onu',
      ipAddress: '10.0.0.50',
      macAddress: 'AA:BB:CC:DD:EE:05',
      location: 'Cliente - Av. Corrientes 1234',
      status: 'offline',
      model: 'Huawei EG8141A5',
      lastSeen: '2026-04-27T18:00:00Z',
    },
  ];

  private inventoryItems: InventoryItem[] = [
    {
      id: '1',
      name: 'Router Doméstico TP-Link',
      category: 'router',
      sku: 'RTR-TPLINK-001',
      quantity: 45,
      minStock: 10,
      unitPrice: 8500,
      supplier: 'TP-Link Argentina',
      location: 'Almacén A - Estante 1',
      status: 'in_stock',
    },
    {
      id: '2',
      name: 'Cable Fibra Óptica SM 8 hilos',
      category: 'cable',
      sku: 'CBL-FO-8H-001',
      quantity: 2500,
      minStock: 500,
      unitPrice: 150,
      supplier: 'Furukawa Electric',
      location: 'Almacén B - Bobinas',
      status: 'in_stock',
    },
    {
      id: '3',
      name: 'Splitter PLC 1:8',
      category: 'splitter',
      sku: 'SPL-PLC-1-8',
      quantity: 8,
      minStock: 20,
      unitPrice: 1200,
      supplier: 'Divisores SA',
      location: 'Almacén A - Estante 3',
      status: 'low_stock',
    },
    {
      id: '4',
      name: 'ONU GPON Huawei EG8141',
      category: 'onu',
      sku: 'ONU-HW-EG8141',
      quantity: 30,
      minStock: 15,
      unitPrice: 12000,
      supplier: 'Huawei Argentina',
      location: 'Almacén A - Estante 2',
      status: 'in_stock',
    },
    {
      id: '5',
      name: 'Kit Herramientas Instalación FTTH',
      category: 'tools',
      sku: 'TOOLS-FTTH-KIT',
      quantity: 3,
      minStock: 5,
      unitPrice: 25000,
      supplier: 'Herramientas Pro',
      location: 'Taller',
      status: 'low_stock',
    },
  ];

  private inventoryProducts: InventoryProduct[] = [
    {
      id: 'prod-1',
      name: 'Router Doméstico TP-Link',
      category: 'router',
      sku: 'RTR-TPLINK-001',
      description: 'Router doméstico hasta 300 Mbps',
      unitPrice: 8500,
      supplier: 'TP-Link Argentina',
      totalStock: 45,
      minStock: 10,
      status: 'in_stock',
    },
    {
      id: 'prod-2',
      name: 'Cable Fibra Óptica SM 8 hilos',
      category: 'cable',
      sku: 'CBL-FO-8H-001',
      description: 'Cable de fibra óptica monomodo 8 hilos',
      unitPrice: 150,
      supplier: 'Furukawa Electric',
      totalStock: 2500,
      minStock: 500,
      status: 'in_stock',
    },
    {
      id: 'prod-3',
      name: 'Splitter PLC 1:8',
      category: 'splitter',
      sku: 'SPL-PLC-1-8',
      description: 'Splitter PLC de 1 a 8 puertos',
      unitPrice: 1200,
      supplier: 'Divisores SA',
      totalStock: 8,
      minStock: 20,
      status: 'low_stock',
    },
    {
      id: 'prod-4',
      name: 'ONU GPON Huawei EG8141',
      category: 'onu',
      sku: 'ONU-HW-EG8141',
      description: 'ONU GPON para instalaciones residenciales',
      unitPrice: 12000,
      supplier: 'Huawei Argentina',
      totalStock: 30,
      minStock: 15,
      status: 'in_stock',
    },
    {
      id: 'prod-5',
      name: 'Kit Herramientas Instalación FTTH',
      category: 'tools',
      sku: 'TOOLS-FTTH-KIT',
      description: 'Kit completo para instalaciones FTTH',
      unitPrice: 25000,
      supplier: 'Herramientas Pro',
      totalStock: 3,
      minStock: 5,
      status: 'low_stock',
    },
  ];

  private inventoryUnits: InventoryUnit[] = [
    {
      id: 'unit-1',
      productId: 'prod-1',
      productName: 'Router Doméstico TP-Link',
      serialNumber: 'RTR001-SN-0001',
      barcode: 'BC-RTR-0001',
      status: 'available',
      location: 'Almacén A - Estante 1',
      purchaseDate: '2025-01-10',
      purchasePrice: 7800,
      assignedToClientId: null,
      assignedAt: null,
      notes: '',
    },
    {
      id: 'unit-2',
      productId: 'prod-1',
      productName: 'Router Doméstico TP-Link',
      serialNumber: 'RTR001-SN-0002',
      barcode: 'BC-RTR-0002',
      status: 'assigned',
      location: 'Cliente - Av. Corrientes 123',
      purchaseDate: '2025-01-10',
      purchasePrice: 7800,
      assignedToClientId: 'cli-001',
      assignedAt: '2025-03-15T10:00:00Z',
      notes: 'Instalado correctamente',
    },
    {
      id: 'unit-3',
      productId: 'prod-2',
      productName: 'Cable Fibra Óptica SM 8 hilos',
      serialNumber: null,
      barcode: 'BC-CBL-0001',
      status: 'available',
      location: 'Almacén B - Bobinas',
      purchaseDate: '2025-02-01',
      purchasePrice: 140,
      assignedToClientId: null,
      assignedAt: null,
      notes: 'Bobina 500m',
    },
    {
      id: 'unit-4',
      productId: 'prod-2',
      productName: 'Cable Fibra Óptica SM 8 hilos',
      serialNumber: null,
      barcode: 'BC-CBL-0002',
      status: 'available',
      location: 'Almacén B - Bobinas',
      purchaseDate: '2025-02-01',
      purchasePrice: 140,
      assignedToClientId: null,
      assignedAt: null,
      notes: 'Bobina 500m',
    },
    {
      id: 'unit-5',
      productId: 'prod-3',
      productName: 'Splitter PLC 1:8',
      serialNumber: 'SPL-SN-0001',
      barcode: 'BC-SPL-0001',
      status: 'available',
      location: 'Almacén A - Estante 3',
      purchaseDate: '2025-03-01',
      purchasePrice: 1100,
      assignedToClientId: null,
      assignedAt: null,
      notes: '',
    },
    {
      id: 'unit-6',
      productId: 'prod-3',
      productName: 'Splitter PLC 1:8',
      serialNumber: 'SPL-SN-0002',
      barcode: 'BC-SPL-0002',
      status: 'damaged',
      location: 'Taller',
      purchaseDate: '2025-03-01',
      purchasePrice: 1100,
      assignedToClientId: null,
      assignedAt: null,
      notes: 'Dañado durante instalación',
    },
    {
      id: 'unit-7',
      productId: 'prod-4',
      productName: 'ONU GPON Huawei EG8141',
      serialNumber: 'ONU-HW-SN-0001',
      barcode: 'BC-ONU-0001',
      status: 'assigned',
      location: 'Cliente - Lavalle 456',
      purchaseDate: '2025-01-20',
      purchasePrice: 11000,
      assignedToClientId: 'cli-002',
      assignedAt: '2025-02-10T09:00:00Z',
      notes: '',
    },
    {
      id: 'unit-8',
      productId: 'prod-4',
      productName: 'ONU GPON Huawei EG8141',
      serialNumber: 'ONU-HW-SN-0002',
      barcode: 'BC-ONU-0002',
      status: 'available',
      location: 'Almacén A - Estante 2',
      purchaseDate: '2025-01-20',
      purchasePrice: 11000,
      assignedToClientId: null,
      assignedAt: null,
      notes: '',
    },
    {
      id: 'unit-9',
      productId: 'prod-5',
      productName: 'Kit Herramientas Instalación FTTH',
      serialNumber: 'KIT-SN-0001',
      barcode: 'BC-KIT-0001',
      status: 'available',
      location: 'Taller',
      purchaseDate: '2024-12-01',
      purchasePrice: 23000,
      assignedToClientId: null,
      assignedAt: null,
      notes: 'Kit completo',
    },
    {
      id: 'unit-10',
      productId: 'prod-5',
      productName: 'Kit Herramientas Instalación FTTH',
      serialNumber: 'KIT-SN-0002',
      barcode: 'BC-KIT-0002',
      status: 'retired',
      location: 'Depósito',
      purchaseDate: '2024-06-01',
      purchasePrice: 23000,
      assignedToClientId: null,
      assignedAt: null,
      notes: 'Herramientas desgastadas, fuera de servicio',
    },
  ];

  // ServicePlan methods
  async findAllServicePlans(subtype?: string): Promise<ServicePlan[]> {
    if (subtype) {
      return this.servicePlans.filter(p => p.planSubtype === subtype);
    }
    return [...this.servicePlans];
  }

  async findServicePlanById(id: string): Promise<ServicePlan | null> {
    return this.servicePlans.find(p => p.id === id) ?? null;
  }

  async createServicePlan(data: Omit<ServicePlan, 'id'>): Promise<ServicePlan> {
    const plan: ServicePlan = { ...data, id: String(nextServicePlanId++) };
    this.servicePlans.push(plan);
    return plan;
  }

  async updateServicePlan(id: string, data: Partial<ServicePlan>): Promise<ServicePlan | null> {
    const index = this.servicePlans.findIndex(p => p.id === id);
    if (index === -1) return null;
    this.servicePlans[index] = { ...this.servicePlans[index], ...data };
    return this.servicePlans[index];
  }

  async deleteServicePlan(id: string): Promise<boolean> {
    const index = this.servicePlans.findIndex(p => p.id === id);
    if (index === -1) return false;
    this.servicePlans.splice(index, 1);
    return true;
  }

  // NetworkDevice methods
  async findAllNetworkDevices(): Promise<NetworkDevice[]> {
    return [...this.networkDevices];
  }

  async findNetworkDeviceById(id: string): Promise<NetworkDevice | null> {
    return this.networkDevices.find(d => d.id === id) ?? null;
  }

  async createNetworkDevice(data: Omit<NetworkDevice, 'id'>): Promise<NetworkDevice> {
    const device: NetworkDevice = { ...data, id: String(nextNetworkDeviceId++) };
    this.networkDevices.push(device);
    return device;
  }

  async updateNetworkDevice(id: string, data: Partial<NetworkDevice>): Promise<NetworkDevice | null> {
    const index = this.networkDevices.findIndex(d => d.id === id);
    if (index === -1) return null;
    this.networkDevices[index] = { ...this.networkDevices[index], ...data };
    return this.networkDevices[index];
  }

  async deleteNetworkDevice(id: string): Promise<boolean> {
    const index = this.networkDevices.findIndex(d => d.id === id);
    if (index === -1) return false;
    this.networkDevices.splice(index, 1);
    return true;
  }

  // InventoryItem methods
  async findAllInventoryItems(): Promise<InventoryItem[]> {
    return [...this.inventoryItems];
  }

  async findInventoryItemById(id: string): Promise<InventoryItem | null> {
    return this.inventoryItems.find(i => i.id === id) ?? null;
  }

  async createInventoryItem(data: Omit<InventoryItem, 'id'>): Promise<InventoryItem> {
    const item: InventoryItem = { ...data, id: String(nextInventoryItemId++) };
    this.inventoryItems.push(item);
    return item;
  }

  async updateInventoryItem(id: string, data: Partial<InventoryItem>): Promise<InventoryItem | null> {
    const index = this.inventoryItems.findIndex(i => i.id === id);
    if (index === -1) return null;
    this.inventoryItems[index] = { ...this.inventoryItems[index], ...data };
    return this.inventoryItems[index];
  }

  async deleteInventoryItem(id: string): Promise<boolean> {
    const index = this.inventoryItems.findIndex(i => i.id === id);
    if (index === -1) return false;
    this.inventoryItems.splice(index, 1);
    return true;
  }

  // InventoryProduct methods
  async findAllInventoryProducts(): Promise<InventoryProduct[]> {
    return [...this.inventoryProducts];
  }

  async findInventoryProductById(id: string): Promise<InventoryProduct | null> {
    return this.inventoryProducts.find(p => p.id === id) ?? null;
  }

  async updateInventoryProduct(id: string, data: Partial<InventoryProduct>): Promise<InventoryProduct | null> {
    const index = this.inventoryProducts.findIndex(p => p.id === id);
    if (index === -1) return null;
    this.inventoryProducts[index] = { ...this.inventoryProducts[index], ...data };
    return this.inventoryProducts[index];
  }

  async deleteInventoryProduct(id: string): Promise<boolean> {
    const index = this.inventoryProducts.findIndex(p => p.id === id);
    if (index === -1) return false;
    this.inventoryProducts.splice(index, 1);
    return true;
  }

  // InventoryUnit methods
  async findAllInventoryUnits(): Promise<InventoryUnit[]> {
    return [...this.inventoryUnits];
  }

  async findInventoryUnitsByProductId(productId: string): Promise<InventoryUnit[]> {
    return this.inventoryUnits.filter(u => u.productId === productId);
  }

  async createInventoryUnit(data: Omit<InventoryUnit, 'id'>): Promise<InventoryUnit> {
    const unit: InventoryUnit = { ...data, id: `unit-${nextInventoryUnitId++}` };
    this.inventoryUnits.push(unit);
    return unit;
  }

  async updateInventoryUnit(id: string, data: Partial<InventoryUnit>): Promise<InventoryUnit | null> {
    const index = this.inventoryUnits.findIndex(u => u.id === id);
    if (index === -1) return null;
    this.inventoryUnits[index] = { ...this.inventoryUnits[index], ...data };
    return this.inventoryUnits[index];
  }

  async deleteInventoryUnit(id: string): Promise<boolean> {
    const index = this.inventoryUnits.findIndex(u => u.id === id);
    if (index === -1) return false;
    this.inventoryUnits.splice(index, 1);
    return true;
  }
}
