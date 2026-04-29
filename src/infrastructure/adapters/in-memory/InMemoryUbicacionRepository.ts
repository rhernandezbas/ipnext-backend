import { Ubicacion } from '@domain/entities/ubicacion';
import { UbicacionRepository } from '@domain/ports/UbicacionRepository';

let nextId = 7;

const SEED: Ubicacion[] = [
  {
    id: '1',
    name: 'Main',
    address: 'Av. Corrientes 1234',
    city: 'Buenos Aires',
    state: 'CABA',
    country: 'Argentina',
    phone: '+54 11 4000-0001',
    email: 'main@ipnext.com.ar',
    manager: 'Admin Principal',
    clientCount: 523,
    status: 'active',
    coordinates: { lat: -34.6037, lng: -58.3816 },
    timezone: 'America/Argentina/Buenos_Aires',
  },
  {
    id: '2',
    name: 'Argentina',
    address: 'Av. Santa Fe 2500',
    city: 'Buenos Aires',
    state: 'Buenos Aires',
    country: 'Argentina',
    phone: '+54 11 4000-0002',
    email: 'argentina@ipnext.com.ar',
    manager: 'Carlos Gómez',
    clientCount: 387,
    status: 'active',
    coordinates: { lat: -34.5958, lng: -58.3947 },
    timezone: 'America/Argentina/Buenos_Aires',
  },
  {
    id: '3',
    name: 'Mercedes',
    address: 'Calle Real 450',
    city: 'Mercedes',
    state: 'Buenos Aires',
    country: 'Argentina',
    phone: '+54 2324 400-100',
    email: 'mercedes@ipnext.com.ar',
    manager: 'María López',
    clientCount: 215,
    status: 'active',
    coordinates: { lat: -34.6516, lng: -59.4307 },
    timezone: 'America/Argentina/Buenos_Aires',
  },
  {
    id: '4',
    name: 'Chivilcoy',
    address: 'Av. Berutti 800',
    city: 'Chivilcoy',
    state: 'Buenos Aires',
    country: 'Argentina',
    phone: '+54 2346 400-200',
    email: 'chivilcoy@ipnext.com.ar',
    manager: 'Juan Pérez',
    clientCount: 178,
    status: 'active',
    coordinates: { lat: -34.8979, lng: -60.0185 },
    timezone: 'America/Argentina/Buenos_Aires',
  },
  {
    id: '5',
    name: 'CABA',
    address: 'Córdoba 1200',
    city: 'Buenos Aires',
    state: 'CABA',
    country: 'Argentina',
    phone: '+54 11 4000-0005',
    email: 'caba@ipnext.com.ar',
    manager: 'Laura Rodríguez',
    clientCount: 412,
    status: 'active',
    coordinates: { lat: -34.6051, lng: -58.3791 },
    timezone: 'America/Argentina/Buenos_Aires',
  },
  {
    id: '6',
    name: 'Achupallas',
    address: 'Ruta 25 km 12',
    city: 'Achupallas',
    state: 'Buenos Aires',
    country: 'Argentina',
    phone: '+54 2343 400-300',
    email: 'achupallas@ipnext.com.ar',
    manager: 'Roberto Sánchez',
    clientCount: 128,
    status: 'inactive',
    coordinates: null,
    timezone: 'America/Argentina/Buenos_Aires',
  },
];

export class InMemoryUbicacionRepository implements UbicacionRepository {
  private ubicaciones: Ubicacion[] = SEED.map(u => ({ ...u }));

  async findAll(): Promise<Ubicacion[]> {
    return [...this.ubicaciones];
  }

  async findById(id: string): Promise<Ubicacion | null> {
    return this.ubicaciones.find(u => u.id === id) ?? null;
  }

  async create(data: Omit<Ubicacion, 'id'>): Promise<Ubicacion> {
    const ubicacion: Ubicacion = {
      ...data,
      id: String(nextId++),
    };
    this.ubicaciones.push(ubicacion);
    return ubicacion;
  }

  async update(id: string, data: Partial<Ubicacion>): Promise<Ubicacion | null> {
    const index = this.ubicaciones.findIndex(u => u.id === id);
    if (index === -1) return null;
    this.ubicaciones[index] = { ...this.ubicaciones[index], ...data };
    return this.ubicaciones[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.ubicaciones.findIndex(u => u.id === id);
    if (index === -1) return false;
    this.ubicaciones.splice(index, 1);
    return true;
  }
}
