import { ServicePlan, NetworkDevice } from '@domain/entities/empresa';
import { EmpresaRepository } from '@domain/ports/EmpresaRepository';

// World A Inventory types (InventoryItem, InventoryProduct, InventoryUnit) removed — Wave 7 (Capstone) retirement.

let nextServicePlanId = 13;
let nextNetworkDeviceId = 6;

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
}
