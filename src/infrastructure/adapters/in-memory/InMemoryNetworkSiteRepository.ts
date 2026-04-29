import { NetworkSite } from '@domain/entities/networkSite';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';

let nextId = 6;

export class InMemoryNetworkSiteRepository implements NetworkSiteRepository {
  private sites: NetworkSite[] = [
    {
      id: '1',
      name: 'Nodo Central',
      address: 'Av. Corrientes 1234',
      city: 'Buenos Aires',
      coordinates: { lat: -34.6037, lng: -58.3816 },
      type: 'nodo',
      status: 'active',
      deviceCount: 12,
      clientCount: 450,
      uplink: '10 Gbps fibra',
      parentSiteId: null,
      description: 'Nodo principal de distribución',
    },
    {
      id: '2',
      name: 'POP Norte',
      address: 'Av. Cabildo 2500',
      city: 'Buenos Aires',
      coordinates: { lat: -34.5516, lng: -58.4563 },
      type: 'pop',
      status: 'active',
      deviceCount: 8,
      clientCount: 220,
      uplink: '1 Gbps fibra',
      parentSiteId: '1',
      description: 'Punto de presencia zona norte',
    },
    {
      id: '3',
      name: 'Torre Sur',
      address: 'Autopista Ricchieri km 12',
      city: 'Ezeiza',
      coordinates: { lat: -34.8422, lng: -58.5281 },
      type: 'tower',
      status: 'active',
      deviceCount: 4,
      clientCount: 85,
      uplink: '500 Mbps radio',
      parentSiteId: '1',
      description: 'Torre de telecomunicaciones zona sur',
    },
    {
      id: '4',
      name: 'Datacenter BA',
      address: 'Av. Del Libertador 5000',
      city: 'Buenos Aires',
      coordinates: { lat: -34.5689, lng: -58.4361 },
      type: 'datacenter',
      status: 'active',
      deviceCount: 32,
      clientCount: 0,
      uplink: '100 Gbps fibra',
      parentSiteId: null,
      description: 'Datacenter principal de la red',
    },
    {
      id: '5',
      name: 'Nodo Oeste',
      address: 'Av. San Martín 900',
      city: 'Morón',
      coordinates: { lat: -34.6524, lng: -58.6189 },
      type: 'nodo',
      status: 'maintenance',
      deviceCount: 6,
      clientCount: 130,
      uplink: '1 Gbps fibra',
      parentSiteId: '1',
      description: 'Nodo de distribución zona oeste',
    },
  ];

  async findAll(): Promise<NetworkSite[]> {
    return [...this.sites];
  }

  async findById(id: string): Promise<NetworkSite | null> {
    return this.sites.find(s => s.id === id) ?? null;
  }

  async create(data: Omit<NetworkSite, 'id'>): Promise<NetworkSite> {
    const site: NetworkSite = { ...data, id: String(nextId++) };
    this.sites.push(site);
    return site;
  }

  async update(id: string, data: Partial<NetworkSite>): Promise<NetworkSite | null> {
    const index = this.sites.findIndex(s => s.id === id);
    if (index === -1) return null;
    this.sites[index] = { ...this.sites[index], ...data };
    return this.sites[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.sites.findIndex(s => s.id === id);
    if (index === -1) return false;
    this.sites.splice(index, 1);
    return true;
  }
}
