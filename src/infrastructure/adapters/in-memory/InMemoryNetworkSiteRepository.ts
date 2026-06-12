import { NetworkSite, fixedCodeFor } from '@domain/entities/networkSite';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';

let nextId = 6;

export class InMemoryNetworkSiteRepository implements NetworkSiteRepository {
  /** Secuencia in-memory que emula `network_site_number_seq`. */
  private nextSiteNumber = 6;

  private sites: NetworkSite[] = [
    {
      id: '1',
      siteNumber: 1,
      fixedCode: 'NODO 1',
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
      iclassNodeCode: 'NC-001',
      uispSiteId: null,
    },
    {
      id: '2',
      siteNumber: 2,
      fixedCode: 'NODO 2',
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
      iclassNodeCode: 'PN-001',
      uispSiteId: null,
    },
    {
      id: '3',
      siteNumber: 3,
      fixedCode: 'NODO 3',
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
      iclassNodeCode: 'TS-001',
      uispSiteId: null,
    },
    {
      id: '4',
      siteNumber: 4,
      fixedCode: 'NODO 4',
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
      iclassNodeCode: null,
      uispSiteId: null,
    },
    {
      id: '5',
      siteNumber: 5,
      fixedCode: 'NODO 5',
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
      iclassNodeCode: 'NO-001',
      uispSiteId: null,
    },
  ];

  /**
   * Test helper: reemplaza toda la lista de sitios con los provistos.
   * Útil para tests que necesitan control total sobre los datos.
   */
  seedSites(sites: NetworkSite[]): void {
    this.sites = [...sites];
    // Mantener la secuencia por delante del mayor siteNumber sembrado, para que
    // create() no colisione con sitios sembrados explícitamente.
    const maxSeeded = sites.reduce((m, s) => Math.max(m, s.siteNumber ?? 0), 0);
    this.nextSiteNumber = Math.max(this.nextSiteNumber, maxSeeded + 1);
  }

  async findAll(): Promise<NetworkSite[]> {
    return [...this.sites];
  }

  async findById(id: string): Promise<NetworkSite | null> {
    return this.sites.find(s => s.id === id) ?? null;
  }

  async findByUispSiteId(uispSiteId: string): Promise<NetworkSite | null> {
    return this.sites.find(s => s.uispSiteId === uispSiteId) ?? null;
  }

  async create(data: Omit<NetworkSite, 'id' | 'siteNumber' | 'fixedCode'>): Promise<NetworkSite> {
    const siteNumber = this.nextSiteNumber++;
    const site: NetworkSite = {
      ...data,
      id: String(nextId++),
      siteNumber,
      fixedCode: fixedCodeFor(siteNumber),
    };
    this.sites.push(site);
    return site;
  }

  async update(id: string, data: Partial<NetworkSite>): Promise<NetworkSite | null> {
    const index = this.sites.findIndex(s => s.id === id);
    if (index === -1) return null;
    // network-site-fixed-code (#51): siteNumber y fixedCode son inmutables — nunca se pisan.
    const { siteNumber: _sn, fixedCode: _fc, ...mutableData } = data;
    this.sites[index] = { ...this.sites[index], ...mutableData };
    return this.sites[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.sites.findIndex(s => s.id === id);
    if (index === -1) return false;
    this.sites.splice(index, 1);
    return true;
  }
}
