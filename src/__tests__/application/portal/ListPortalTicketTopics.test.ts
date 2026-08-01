/**
 * portal-ticket-topic (BE) — ListPortalTicketTopics.
 *
 * El cliente ELIGE un tópico al abrir un reclamo (en vez de que el área salga
 * siempre del config). SOLO expone áreas `portalVisible = true` — NOC/GigaRed
 * son áreas INTERNAS y jamás deben aparecer acá. Fixture SIEMPRE con >=2
 * visibles y >=2 internas (fixture degenerado de un solo elemento por lado
 * deja pasar mutantes, ver InMemoryTicketAreaCatalogRepository.test.ts).
 */
import { ListPortalTicketTopics } from '@application/use-cases/portal/ListPortalTicketTopics';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';

describe('ListPortalTicketTopics — portal-ticket-topic', () => {
  it('NO devuelve las áreas internas (fixture con >=2 visibles y >=2 internas)', async () => {
    const areas = new InMemoryTicketAreaCatalogRepository();
    await areas.create({ name: 'Soporte', color: '#1', portalVisible: true, portalLabel: 'Problemas técnicos', portalOrder: 1 });
    await areas.create({ name: 'Facturación', color: '#2', portalVisible: true, portalLabel: 'Facturas y pagos', portalOrder: 2 });
    await areas.create({ name: 'NOC', color: '#3', portalVisible: false });
    await areas.create({ name: 'GigaRed', color: '#4', portalVisible: false });
    const useCase = new ListPortalTicketTopics(areas);

    const result = await useCase.execute();

    expect(result).toHaveLength(2);
    expect(result.some((t) => t.label === 'NOC' || t.label === 'GigaRed')).toBe(false);
  });

  it('respeta el orden portalOrder ASC y desempata por name', async () => {
    const areas = new InMemoryTicketAreaCatalogRepository();
    await areas.create({ name: 'Charlie', color: '#1', portalVisible: true, portalLabel: 'C', portalOrder: 2 });
    await areas.create({ name: 'Alpha', color: '#2', portalVisible: true, portalLabel: 'A', portalOrder: 1 });
    await areas.create({ name: 'Bravo', color: '#3', portalVisible: true, portalLabel: 'B', portalOrder: 1 });
    const useCase = new ListPortalTicketTopics(areas);

    const result = await useCase.execute();

    expect(result.map((t) => t.label)).toEqual(['A', 'B', 'C']);
  });

  it('label cae a name cuando portalLabel es null', async () => {
    const areas = new InMemoryTicketAreaCatalogRepository();
    await areas.create({ name: 'Soporte', color: '#1', portalVisible: true }); // sin portalLabel
    const useCase = new ListPortalTicketTopics(areas);

    const result = await useCase.execute();

    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('Soporte');
  });

  it('description es null cuando portalDescription no está cargada', async () => {
    const areas = new InMemoryTicketAreaCatalogRepository();
    await areas.create({ name: 'Soporte', color: '#1', portalVisible: true, portalLabel: 'Problemas técnicos' });
    const useCase = new ListPortalTicketTopics(areas);

    const result = await useCase.execute();

    expect(result[0]!.description).toBeNull();
  });

  it('NUNCA expone name interno, color ni portalVisible en el DTO', async () => {
    const areas = new InMemoryTicketAreaCatalogRepository();
    await areas.create({ name: 'Soporte', color: '#6366f1', portalVisible: true, portalLabel: 'Problemas técnicos', portalDescription: 'desc' });
    const useCase = new ListPortalTicketTopics(areas);

    const result = await useCase.execute();

    expect(Object.keys(result[0]!).sort()).toEqual(['description', 'id', 'label']);
  });
});
