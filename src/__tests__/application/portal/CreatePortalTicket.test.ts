/**
 * customer-portal-api (Fase 5, task 5.2) — CreatePortalTicket.
 *
 * portal-self-service spec "Cliente crea un reclamo" + "Payload inválido".
 * Usa InMemoryTicketRepository + InMemoryTicketAreaCatalogRepository (adapters
 * reales, compartidos con el admin).
 */
import { CreatePortalTicket, PORTAL_TICKET_SUBJECT_MAX_LEN, PORTAL_TICKET_DESCRIPTION_MAX_LEN } from '@application/use-cases/portal/CreatePortalTicket';
import { PortalTicketValidationError } from '@domain/errors/portal.errors';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';

describe('CreatePortalTicket — customer-portal-api Fase 5.2', () => {
  it('scenario "Cliente crea un reclamo": crea el ticket asociado a su cliente con status inicial del catalogo', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    tickets.seedAreas(areas); // JOIN-derived areaName — mismo patron que el resto del repo
    await areas.create({ name: 'Atención al cliente', color: '#111111' });
    const useCase = new CreatePortalTicket(tickets, areas);

    const result = await useCase.execute('client-a', { subject: 'No anda internet', description: 'Desde ayer a la tarde' });

    expect(result.subject).toBe('No anda internet');
    expect(result.description).toBe('Desde ayer a la tarde');
    expect(result.status).toBe('open');
    expect(result.number).toEqual(expect.any(Number));

    const created = await tickets.getById((await tickets.list({ customerId: 'client-a' })).data[0]!.id);
    expect(created?.customerId).toBe('client-a');
    expect(created?.areaName).toBe('Atención al cliente');
  });

  it('área configurada resuelta por NOMBRE contra el catálogo', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const supportArea = await areas.create({ name: 'Soporte Técnico', color: '#222222' });
    const useCase = new CreatePortalTicket(tickets, areas, 'Soporte Técnico');

    await useCase.execute('client-a', { subject: 'Falla', description: 'detalle' });

    const listed = await tickets.list({ customerId: 'client-a' });
    expect(listed.data[0]!.areaId).toBe(supportArea.id);
  });

  it('área configurada NO existe en el catálogo -> fallback a la primera del catálogo, JAMÁS crea una nueva', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const onlyArea = await areas.create({ name: 'NOC', color: '#333333' });
    const useCase = new CreatePortalTicket(tickets, areas, 'Área que no existe');

    await useCase.execute('client-a', { subject: 'Falla', description: 'detalle' });

    const catalogAfter = await areas.list();
    expect(catalogAfter).toHaveLength(1); // ninguna área nueva creada
    const listed = await tickets.list({ customerId: 'client-a' });
    expect(listed.data[0]!.areaId).toBe(onlyArea.id);
  });

  it('scenario "Payload inválido": falta subject o description -> error de validación', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const useCase = new CreatePortalTicket(tickets, areas);

    await expect(useCase.execute('client-a', { subject: '', description: 'algo' })).rejects.toThrow(PortalTicketValidationError);
    await expect(useCase.execute('client-a', { subject: 'algo', description: '' })).rejects.toThrow(PortalTicketValidationError);
  });

  it('scenario "Payload inválido": largos maximos excedidos -> error de validación', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const useCase = new CreatePortalTicket(tickets, areas);

    const longSubject = 'x'.repeat(PORTAL_TICKET_SUBJECT_MAX_LEN + 1);
    const longDescription = 'y'.repeat(PORTAL_TICKET_DESCRIPTION_MAX_LEN + 1);

    await expect(useCase.execute('client-a', { subject: longSubject, description: 'ok' })).rejects.toThrow(PortalTicketValidationError);
    await expect(useCase.execute('client-a', { subject: 'ok', description: longDescription })).rejects.toThrow(PortalTicketValidationError);
  });

  it('anti-IDOR: el ticket queda asociado SOLO al clientId recibido, nunca a otro', async () => {
    const tickets = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    const useCase = new CreatePortalTicket(tickets, areas);

    await useCase.execute('client-a', { subject: 'De A', description: 'd' });
    await useCase.execute('client-b', { subject: 'De B', description: 'd' });

    const forA = await tickets.list({ customerId: 'client-a' });
    const forB = await tickets.list({ customerId: 'client-b' });
    expect(forA.data.map((t) => t.subject)).toEqual(['De A']);
    expect(forB.data.map((t) => t.subject)).toEqual(['De B']);
  });
});
