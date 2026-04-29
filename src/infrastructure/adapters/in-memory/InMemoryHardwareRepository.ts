import { HardwareAsset } from '@domain/entities/hardware';
import { HardwareRepository } from '@domain/ports/HardwareRepository';

let nextId = 9;

export class InMemoryHardwareRepository implements HardwareRepository {
  private assets: HardwareAsset[] = [
    {
      id: '1',
      name: 'Servidor de autenticación RADIUS',
      category: 'server',
      serialNumber: 'SRV-001-2024',
      model: 'PowerEdge R340',
      manufacturer: 'Dell',
      purchaseDate: '2024-03-15',
      purchasePrice: 450000,
      warrantyExpiry: '2027-03-15',
      location: 'Datacenter BA, Rack A, Slot 1',
      networkSiteId: '4',
      status: 'in_use',
      assignedTo: 'RADIUS Server',
      notes: 'Servidor principal de autenticación RADIUS',
    },
    {
      id: '2',
      name: 'Servidor de monitoreo',
      category: 'server',
      serialNumber: 'SRV-002-2024',
      model: 'ProLiant DL360 Gen10',
      manufacturer: 'HP',
      purchaseDate: '2024-06-01',
      purchasePrice: 620000,
      warrantyExpiry: '2027-06-01',
      location: 'Datacenter BA, Rack A, Slot 2',
      networkSiteId: '4',
      status: 'in_use',
      assignedTo: 'Zabbix Monitoring',
      notes: 'Servidor de monitoreo Zabbix + Grafana',
    },
    {
      id: '3',
      name: 'Switch core 48 puertos',
      category: 'switch',
      serialNumber: 'SW-001-2023',
      model: 'CRS354-48G-4S+2Q+RM',
      manufacturer: 'MikroTik',
      purchaseDate: '2023-08-20',
      purchasePrice: 185000,
      warrantyExpiry: '2026-08-20',
      location: 'Nodo Central, Rack B, Slot 1',
      networkSiteId: '1',
      status: 'in_use',
      assignedTo: 'Core network',
      notes: 'Switch core principal con fibra',
    },
    {
      id: '4',
      name: 'Switch distribución',
      category: 'switch',
      serialNumber: 'SW-002-2023',
      model: 'CRS326-24G-2S+RM',
      manufacturer: 'MikroTik',
      purchaseDate: '2023-10-05',
      purchasePrice: 78000,
      warrantyExpiry: '2026-10-05',
      location: 'POP Norte, Rack A, Slot 1',
      networkSiteId: '2',
      status: 'in_use',
      assignedTo: 'Distribution POP Norte',
      notes: 'Switch de distribución zona norte',
    },
    {
      id: '5',
      name: 'Router BGP principal',
      category: 'router',
      serialNumber: 'RTR-001-2024',
      model: 'CCR2004-16G-2S+',
      manufacturer: 'MikroTik',
      purchaseDate: '2024-01-10',
      purchasePrice: 320000,
      warrantyExpiry: '2027-01-10',
      location: 'Datacenter BA, Rack A, Slot 3',
      networkSiteId: '4',
      status: 'in_use',
      assignedTo: 'BGP peering',
      notes: 'Router principal BGP con upstream',
    },
    {
      id: '6',
      name: 'UPS 3000VA',
      category: 'ups',
      serialNumber: 'UPS-001-2023',
      model: 'Smart-UPS 3000',
      manufacturer: 'APC',
      purchaseDate: '2023-05-15',
      purchasePrice: 95000,
      warrantyExpiry: '2026-05-15',
      location: 'Nodo Central, Rack B',
      networkSiteId: '1',
      status: 'in_use',
      assignedTo: 'Nodo Central power backup',
      notes: 'UPS con 15 min de autonomía',
    },
    {
      id: '7',
      name: 'Rack 42U',
      category: 'rack',
      serialNumber: 'RACK-001-2022',
      model: 'APC NetShelter SX 42U',
      manufacturer: 'APC',
      purchaseDate: '2022-11-01',
      purchasePrice: 145000,
      warrantyExpiry: null,
      location: 'Datacenter BA, Row A',
      networkSiteId: '4',
      status: 'in_use',
      assignedTo: 'Core equipment',
      notes: 'Rack principal datacenter BA',
    },
    {
      id: '8',
      name: 'Módulo SFP+ 10G fibra',
      category: 'sfp',
      serialNumber: 'SFP-001-2024',
      model: 'S+85DLC03D',
      manufacturer: 'MikroTik',
      purchaseDate: '2024-04-01',
      purchasePrice: 8500,
      warrantyExpiry: '2027-04-01',
      location: 'Almacén',
      networkSiteId: null,
      status: 'spare',
      assignedTo: null,
      notes: 'Módulo SFP+ 10G LC multimodo en repuesto',
    },
  ];

  async findAll(): Promise<HardwareAsset[]> {
    return [...this.assets];
  }

  async create(data: Omit<HardwareAsset, 'id'>): Promise<HardwareAsset> {
    const asset: HardwareAsset = { ...data, id: String(nextId++) };
    this.assets.push(asset);
    return asset;
  }

  async update(id: string, data: Partial<HardwareAsset>): Promise<HardwareAsset | null> {
    const index = this.assets.findIndex(a => a.id === id);
    if (index === -1) return null;
    this.assets[index] = { ...this.assets[index], ...data };
    return this.assets[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.assets.findIndex(a => a.id === id);
    if (index === -1) return false;
    this.assets.splice(index, 1);
    return true;
  }
}
