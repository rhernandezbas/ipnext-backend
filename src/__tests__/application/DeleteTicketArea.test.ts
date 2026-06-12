import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { CreateTicketArea } from '@application/use-cases/CreateTicketArea';
import { ListTicketAreas } from '@application/use-cases/ListTicketAreas';
import { DeleteTicketArea } from '@application/use-cases/DeleteTicketArea';
import {
  TicketAreaInUseError,
  TicketAreaNotFoundError,
} from '@domain/errors/tickets';

describe('DeleteTicketArea', () => {
  let repo: InMemoryTicketAreaCatalogRepository;
  let createArea: CreateTicketArea;
  let listAreas: ListTicketAreas;
  let deleteArea: DeleteTicketArea;

  beforeEach(() => {
    repo = new InMemoryTicketAreaCatalogRepository();
    createArea = new CreateTicketArea(repo);
    listAreas = new ListTicketAreas(repo);
    deleteArea = new DeleteTicketArea(repo);
  });

  it('deletes an unused area and removes it from list', async () => {
    const area = await createArea.execute({ name: 'Soporte' });
    await deleteArea.execute(area.id);
    expect(await listAreas.execute()).toHaveLength(0);
  });

  it('throws TicketAreaNotFoundError (404) when area does not exist', async () => {
    await expect(deleteArea.execute('nonexistent-id')).rejects.toBeInstanceOf(
      TicketAreaNotFoundError,
    );
  });

  it('throws TicketAreaInUseError (409) when area has tickets', async () => {
    const area = await createArea.execute({ name: 'Soporte' });
    repo.ticketCounts[area.id] = 3;
    await expect(deleteArea.execute(area.id)).rejects.toBeInstanceOf(TicketAreaInUseError);
  });

  it('allows deleting any seed area (no protection)', async () => {
    const soporte = await createArea.execute({ name: 'Soporte' });
    await expect(deleteArea.execute(soporte.id)).resolves.toBeUndefined();
  });
});
