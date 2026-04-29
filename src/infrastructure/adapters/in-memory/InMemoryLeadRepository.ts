import { Lead } from '@domain/entities/lead';
import { LeadRepository } from '@domain/ports/LeadRepository';

let nextId = 9;

const SEED: Lead[] = [
  {
    id: '1',
    name: 'Federico Álvarez',
    email: 'federico.alvarez@gmail.com',
    phone: '11-4521-8890',
    address: 'Av. Santa Fe 2345',
    city: 'Buenos Aires',
    source: 'website',
    status: 'new',
    assignedTo: 'María López',
    assignedToId: 'admin-1',
    interestedIn: 'Plan Estándar 100Mbps',
    notes: 'Consultó a través del formulario web. Interesado en fibra óptica.',
    followUpDate: '2026-05-05',
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    convertedAt: null,
    convertedClientId: null,
  },
  {
    id: '2',
    name: 'Valeria Moreno',
    email: 'valeria.moreno@hotmail.com',
    phone: '11-3344-5566',
    address: 'Corrientes 1500',
    city: 'Buenos Aires',
    source: 'referral',
    status: 'contacted',
    assignedTo: 'Carlos Gómez',
    assignedToId: 'admin-2',
    interestedIn: 'Plan Premium 300Mbps',
    notes: 'Referida por cliente activo. Ya se realizó primer contacto por teléfono.',
    followUpDate: '2026-05-03',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    convertedAt: null,
    convertedClientId: null,
  },
  {
    id: '3',
    name: 'Martín Suárez',
    email: 'martin.suarez@empresa.com',
    phone: '11-7788-9900',
    address: 'Florida 890',
    city: 'CABA',
    source: 'cold_call',
    status: 'qualified',
    assignedTo: 'María López',
    assignedToId: 'admin-1',
    interestedIn: 'Plan Empresarial 500Mbps',
    notes: 'Empresa con 15 empleados. Necesita IP fija y SLA garantizado.',
    followUpDate: '2026-05-02',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    convertedAt: null,
    convertedClientId: null,
  },
  {
    id: '4',
    name: 'Luciana Benítez',
    email: 'luciana.benitez@gmail.com',
    phone: '221-4443-2211',
    address: 'Diagonal 74 N°1200',
    city: 'La Plata',
    source: 'social_media',
    status: 'proposal_sent',
    assignedTo: 'Carlos Gómez',
    assignedToId: 'admin-2',
    interestedIn: 'Plan Hogar 50Mbps',
    notes: 'Contacto vía Instagram. Propuesta enviada por email el 25/04.',
    followUpDate: '2026-05-01',
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    convertedAt: null,
    convertedClientId: null,
  },
  {
    id: '5',
    name: 'Rodrigo Fontana',
    email: 'rfontana@outlook.com',
    phone: '221-5566-7788',
    address: 'Calle 13 N°450',
    city: 'La Plata',
    source: 'website',
    status: 'won',
    assignedTo: 'María López',
    assignedToId: 'admin-1',
    interestedIn: 'Plan Estándar 100Mbps',
    notes: 'Firmó contrato el 20/04. Instalación programada para el 30/04.',
    followUpDate: null,
    createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    convertedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    convertedClientId: 'client-892',
  },
  {
    id: '6',
    name: 'Silvia Romero',
    email: 'silvia.romero@yahoo.com',
    phone: '341-4421-0099',
    address: 'Oroño 500',
    city: 'Rosario',
    source: 'referral',
    status: 'lost',
    assignedTo: 'Carlos Gómez',
    assignedToId: 'admin-2',
    interestedIn: 'Plan Hogar 50Mbps',
    notes: 'Decidió contratar con la competencia por menor precio.',
    followUpDate: null,
    createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    convertedAt: null,
    convertedClientId: null,
  },
  {
    id: '7',
    name: 'Diego Pereyra',
    email: 'diego.pereyra@gmail.com',
    phone: '11-6677-8899',
    address: 'Rivadavia 3400',
    city: 'Buenos Aires',
    source: 'other',
    status: 'new',
    assignedTo: 'María López',
    assignedToId: 'admin-1',
    interestedIn: 'Plan Estándar 100Mbps',
    notes: 'Consultó en persona en la oficina.',
    followUpDate: '2026-05-06',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    convertedAt: null,
    convertedClientId: null,
  },
  {
    id: '8',
    name: 'Natalia Vega',
    email: 'natalia.vega@empresa.net',
    phone: '351-4488-7766',
    address: 'Colón 700',
    city: 'Córdoba',
    source: 'social_media',
    status: 'contacted',
    assignedTo: 'Carlos Gómez',
    assignedToId: 'admin-2',
    interestedIn: 'Plan Premium 300Mbps',
    notes: 'Contacto por LinkedIn. Pyme del sector retail.',
    followUpDate: '2026-05-04',
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    convertedAt: null,
    convertedClientId: null,
  },
];

export class InMemoryLeadRepository implements LeadRepository {
  private leads: Lead[] = SEED.map(l => ({ ...l }));

  async findAll(): Promise<Lead[]> {
    return [...this.leads];
  }

  async findById(id: string): Promise<Lead | null> {
    return this.leads.find(l => l.id === id) ?? null;
  }

  async create(data: Omit<Lead, 'id' | 'createdAt' | 'convertedAt' | 'convertedClientId'>): Promise<Lead> {
    const lead: Lead = {
      ...data,
      id: String(nextId++),
      createdAt: new Date().toISOString(),
      convertedAt: null,
      convertedClientId: null,
    };
    this.leads.push(lead);
    return lead;
  }

  async update(id: string, data: Partial<Lead>): Promise<Lead | null> {
    const index = this.leads.findIndex(l => l.id === id);
    if (index === -1) return null;
    this.leads[index] = { ...this.leads[index], ...data };
    return this.leads[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.leads.findIndex(l => l.id === id);
    if (index === -1) return false;
    this.leads.splice(index, 1);
    return true;
  }

  async convertToClient(id: string, clientId: string): Promise<Lead | null> {
    const index = this.leads.findIndex(l => l.id === id);
    if (index === -1) return null;
    this.leads[index] = {
      ...this.leads[index],
      status: 'won',
      convertedAt: new Date().toISOString(),
      convertedClientId: clientId,
    };
    return this.leads[index];
  }
}
