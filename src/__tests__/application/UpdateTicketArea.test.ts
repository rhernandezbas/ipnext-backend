import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { CreateTicketArea } from '@application/use-cases/CreateTicketArea';
import { UpdateTicketArea } from '@application/use-cases/UpdateTicketArea';
import {
  TicketAreaNameConflictError,
  TicketAreaNotFoundError,
} from '@domain/errors/tickets';

describe('UpdateTicketArea', () => {
  let repo: InMemoryTicketAreaCatalogRepository;
  let createArea: CreateTicketArea;
  let updateArea: UpdateTicketArea;

  beforeEach(() => {
    repo = new InMemoryTicketAreaCatalogRepository();
    createArea = new CreateTicketArea(repo);
    updateArea = new UpdateTicketArea(repo);
  });

  it('renames an area successfully', async () => {
    const area = await createArea.execute({ name: 'Soporte' });
    const updated = await updateArea.execute(area.id, { name: 'Soporte Técnico' });
    expect(updated.name).toBe('Soporte Técnico');
  });

  it('allows updating to the same name (no false conflict)', async () => {
    const area = await createArea.execute({ name: 'Soporte' });
    const updated = await updateArea.execute(area.id, { name: 'Soporte' });
    expect(updated.name).toBe('Soporte');
  });

  it('throws TicketAreaNameConflictError (409) when name collides with another area', async () => {
    await createArea.execute({ name: 'Soporte' });
    const area2 = await createArea.execute({ name: 'Facturación' });
    await expect(updateArea.execute(area2.id, { name: 'Soporte' })).rejects.toBeInstanceOf(
      TicketAreaNameConflictError,
    );
  });

  it('throws TicketAreaNotFoundError (404) when area does not exist', async () => {
    await expect(updateArea.execute('nonexistent-id', { name: 'X' })).rejects.toBeInstanceOf(
      TicketAreaNotFoundError,
    );
  });
});
