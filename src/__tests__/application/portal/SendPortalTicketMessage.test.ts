/**
 * portal-ticket-messaging (v2.B) — SendPortalTicketMessage.
 *
 * spec "El cliente lee y escribe en SU reclamo" + "La visibilidad la determina
 * la RUTA, no el payload": este use case NUNCA acepta `visibility`/`authorKind`
 * como input — son literales fijos (`client`/`public`) dentro de la clase. Los
 * tests de "no hay forma de cambiarlo" viven a nivel de TIPOS (la interfaz
 * `SendPortalTicketMessageInput` no tiene el campo) — acá se prueba el
 * COMPORTAMIENTO: pase lo que pase, el resultado siempre es client+public.
 */
import { SendPortalTicketMessage } from '@application/use-cases/portal/SendPortalTicketMessage';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { TicketMessageValidationError, UnsupportedTicketMessageAttachmentTypeError } from '@domain/errors/ticketMessage';

function makeUseCase() {
  const tickets = new InMemoryTicketRepository();
  const comments = new InMemoryTicketCommentRepository();
  const storage = new InMemoryFileStorage();
  return { tickets, comments, storage, useCase: new SendPortalTicketMessage(tickets, comments, storage) };
}

describe('SendPortalTicketMessage — customer-portal-api v2.B', () => {
  it('crea el mensaje SIEMPRE authorKind=client + visibility=public', async () => {
    const { tickets, comments, useCase } = makeUseCase();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    const result = await useCase.execute('client-a', 'acc-1', ticket.sequenceNumber, { body: 'hola', files: [] });

    expect(result).not.toBeNull();
    expect(result!.authorKind).toBe('client');
    const stored = await comments.listByTicket(ticket.id);
    expect(stored[0]!.visibility).toBe('public');
    expect(stored[0]!.authorKind).toBe('client');
    expect(stored[0]!.authorId).toBe('acc-1');
  });

  it('scenario "Reclamo ajeno": ticket de otro cliente -> null, no crea nada', async () => {
    const { tickets, comments, useCase } = makeUseCase();
    const ticketB = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-b' });

    const result = await useCase.execute('client-a', 'acc-1', ticketB.sequenceNumber, { body: 'hola', files: [] });

    expect(result).toBeNull();
    expect(await comments.listByTicket(ticketB.id)).toHaveLength(0);
  });

  it('scenario "Mensaje vacío": sin texto y sin adjuntos -> TicketMessageValidationError, no crea nada', async () => {
    const { tickets, comments, useCase } = makeUseCase();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    await expect(useCase.execute('client-a', 'acc-1', ticket.sequenceNumber, { body: '   ', files: [] })).rejects.toBeInstanceOf(TicketMessageValidationError);
    expect(await comments.listByTicket(ticket.id)).toHaveLength(0);
  });

  it('scenario "Mensaje gigante": excede el largo máximo -> TicketMessageValidationError', async () => {
    const { tickets, useCase } = makeUseCase();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    await expect(
      useCase.execute('client-a', 'acc-1', ticket.sequenceNumber, { body: 'x'.repeat(5000), files: [] }),
    ).rejects.toBeInstanceOf(TicketMessageValidationError);
  });

  it('scenario "Cliente manda una foto del módem": adjunto dentro de los límites -> se crea con su adjunto', async () => {
    const { tickets, storage, useCase } = makeUseCase();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    const result = await useCase.execute('client-a', 'acc-1', ticket.sequenceNumber, {
      body: 'mirá',
      files: [{ buffer: Buffer.from([0xff, 0xd8, 0xff]), originalName: 'modem.jpg', mimeType: 'image/jpeg' }],
    });

    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0]!.kind).toBe('image');
    expect(storage.store.size).toBe(1);
  });

  it('scenario "Tipo no permitido": un ejecutable -> 415-mapped error, y NO se guarda nada en el storage', async () => {
    const { tickets, storage, useCase } = makeUseCase();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    await expect(
      useCase.execute('client-a', 'acc-1', ticket.sequenceNumber, {
        body: '',
        files: [{ buffer: Buffer.from('x'), originalName: 'virus.exe', mimeType: 'application/x-msdownload' }],
      }),
    ).rejects.toBeInstanceOf(UnsupportedTicketMessageAttachmentTypeError);
    expect(storage.store.size).toBe(0);
  });
});
