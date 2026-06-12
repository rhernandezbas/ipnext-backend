import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { CreateTicketArea } from '@application/use-cases/CreateTicketArea';
import {
  TicketAreaNameConflictError,
} from '@domain/errors/tickets';

describe('CreateTicketArea', () => {
  let repo: InMemoryTicketAreaCatalogRepository;
  let createArea: CreateTicketArea;

  beforeEach(() => {
    repo = new InMemoryTicketAreaCatalogRepository();
    createArea = new CreateTicketArea(repo);
  });

  it('creates an area and returns it with an id', async () => {
    const area = await createArea.execute({ name: 'Soporte', color: '#6366f1' });
    expect(area.id).toBeTruthy();
    expect(area.name).toBe('Soporte');
  });

  it('persists the color (#69)', async () => {
    const area = await createArea.execute({ name: 'Soporte', color: '#6366f1' });
    expect(area.color).toBe('#6366f1');
  });

  it('throws TicketAreaNameConflictError (409) on duplicate name', async () => {
    await createArea.execute({ name: 'Soporte', color: '#6366f1' });
    await expect(createArea.execute({ name: 'Soporte', color: '#10b981' })).rejects.toBeInstanceOf(
      TicketAreaNameConflictError,
    );
  });

  it('name conflict check is case-insensitive', async () => {
    await createArea.execute({ name: 'Soporte', color: '#6366f1' });
    await expect(createArea.execute({ name: 'soporte', color: '#10b981' })).rejects.toBeInstanceOf(
      TicketAreaNameConflictError,
    );
  });
});
