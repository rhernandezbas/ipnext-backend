import { Partner } from '@domain/entities/partner';
import { PartnerRepository } from '@domain/ports/PartnerRepository';

let nextId = 4;

export class InMemoryPartnerRepository implements PartnerRepository {
  private partners: Partner[] = [
    {
      id: '1',
      name: 'IPNEXT Buenos Aires',
      status: 'active',
      primaryEmail: 'ba@ipnext.com.ar',
      phone: '+541100000000',
      address: 'Av. Corrientes 1234',
      city: 'Buenos Aires',
      country: 'AR',
      timezone: 'America/Argentina/Buenos_Aires',
      currency: 'ARS',
      logoUrl: null,
      clientCount: 1250,
      adminCount: 8,
      createdAt: '2023-01-01T00:00:00Z',
    },
    {
      id: '2',
      name: 'IPNEXT Córdoba',
      status: 'active',
      primaryEmail: 'cba@ipnext.com.ar',
      phone: '+543510000000',
      address: 'Av. Colón 500',
      city: 'Córdoba',
      country: 'AR',
      timezone: 'America/Argentina/Cordoba',
      currency: 'ARS',
      logoUrl: null,
      clientCount: 430,
      adminCount: 3,
      createdAt: '2023-06-01T00:00:00Z',
    },
    {
      id: '3',
      name: 'IPNEXT Rosario',
      status: 'inactive',
      primaryEmail: 'ros@ipnext.com.ar',
      phone: '+543410000000',
      address: 'Bv. Oroño 200',
      city: 'Rosario',
      country: 'AR',
      timezone: 'America/Argentina/Buenos_Aires',
      currency: 'ARS',
      logoUrl: null,
      clientCount: 0,
      adminCount: 1,
      createdAt: '2024-01-15T00:00:00Z',
    },
  ];

  async findAll(): Promise<Partner[]> {
    return [...this.partners];
  }

  async findById(id: string): Promise<Partner | null> {
    return this.partners.find(p => p.id === id) ?? null;
  }

  async create(data: Omit<Partner, 'id' | 'createdAt' | 'clientCount' | 'adminCount'>): Promise<Partner> {
    const partner: Partner = {
      ...data,
      id: String(nextId++),
      clientCount: 0,
      adminCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.partners.push(partner);
    return partner;
  }

  async update(id: string, data: Partial<Partner>): Promise<Partner | null> {
    const index = this.partners.findIndex(p => p.id === id);
    if (index === -1) return null;
    this.partners[index] = { ...this.partners[index], ...data };
    return this.partners[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.partners.findIndex(p => p.id === id);
    if (index === -1) return false;
    this.partners.splice(index, 1);
    return true;
  }
}
