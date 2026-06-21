import { randomUUID } from 'crypto';
import { Zone } from '@domain/entities/zone';
import { ZoneRepository, CreateZoneInput, UpdateZoneInput } from '@domain/ports/ZoneRepository';

export class InMemoryZoneRepository implements ZoneRepository {
  private readonly store: Zone[] = [];
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  async create(input: CreateZoneInput): Promise<Zone> {
    const ts = this.now().toISOString();
    const zone: Zone = {
      id: randomUUID(),
      name: input.name,
      color: input.color,
      points: input.points.map(p => ({ lat: p.lat, lng: p.lng })),
      description: input.description ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.store.push(zone);
    return { ...zone, points: zone.points.map(p => ({ ...p })) };
  }

  async findById(id: string): Promise<Zone | null> {
    const z = this.store.find(z => z.id === id);
    return z ? { ...z, points: z.points.map(p => ({ ...p })) } : null;
  }

  async list(): Promise<Zone[]> {
    return this.store.map(z => ({ ...z, points: z.points.map(p => ({ ...p })) }));
  }

  async update(id: string, input: UpdateZoneInput): Promise<Zone | null> {
    const idx = this.store.findIndex(z => z.id === id);
    if (idx === -1) return null;
    const existing = this.store[idx];
    const ts = this.now().toISOString();
    const updated: Zone = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.points !== undefined ? { points: input.points.map(p => ({ ...p })) } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: ts,
    };
    this.store[idx] = updated;
    return { ...updated, points: updated.points.map(p => ({ ...p })) };
  }

  async delete(id: string): Promise<void> {
    const idx = this.store.findIndex(z => z.id === id);
    if (idx !== -1) this.store.splice(idx, 1);
  }
}
