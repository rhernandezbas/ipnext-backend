/**
 * markMessagesRead — G7 (fix wave FINAL): cursor no monótono.
 *
 * `markMessagesRead` hacía un `update`/`updateMany` INCONDICIONAL: dos GET
 * concurrentes del mismo lado (dos pestañas, o un pull-to-refresh que se
 * solapa con el GET anterior) pueden resolver — y por lo tanto persistir —
 * en CUALQUIER orden. Si el que tiene el `at` MÁS VIEJO gana la carrera de
 * escritura (llega último a la DB), el cursor RETROCEDE: mensajes que ya
 * estaban marcados leídos (con un `at` más nuevo) vuelven a contar como
 * no-leídos y el badge reaparece sin que haya un mensaje nuevo real.
 *
 * Fix: el cursor solo avanza — nunca hacia atrás. Se prueba contra AMBOS
 * adapters (`InMemoryTicketRepository`, que es lo que ejercitan los use
 * cases en tests, y `PrismaTicketRepository`, mocked, que es lo que corre en
 * prod) para que no diverjan (mismo criterio que el resto de la suite de
 * adapters de esta fix wave).
 */
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';

describe('InMemoryTicketRepository.markMessagesRead — cursor monótono (G7)', () => {
  it('un `at` MÁS VIEJO que el cursor actual NO lo retrocede — revert-probe: volver al update incondicional pone este test en rojo', async () => {
    const repo = new InMemoryTicketRepository();
    const ticket = await repo.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    const later = new Date('2026-01-01T00:10:00.000Z');
    const earlier = new Date('2026-01-01T00:05:00.000Z');

    await repo.markMessagesRead(ticket.id, 'client', later);
    await repo.markMessagesRead(ticket.id, 'client', earlier); // GET más viejo que "gana" la carrera de escritura

    const reloaded = await repo.getBySequenceNumber(ticket.sequenceNumber);
    expect(reloaded!.clientMessagesReadAt).toBe(later.toISOString());
  });

  it('un `at` MÁS NUEVO SÍ avanza el cursor (el caso normal, no regresivo)', async () => {
    const repo = new InMemoryTicketRepository();
    const ticket = await repo.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    const first = new Date('2026-01-01T00:05:00.000Z');
    const second = new Date('2026-01-01T00:10:00.000Z');

    await repo.markMessagesRead(ticket.id, 'client', first);
    await repo.markMessagesRead(ticket.id, 'client', second);

    const reloaded = await repo.getBySequenceNumber(ticket.sequenceNumber);
    expect(reloaded!.clientMessagesReadAt).toBe(second.toISOString());
  });

  it('el primer marcado (cursor null) siempre se aplica, sin importar el valor de `at`', async () => {
    const repo = new InMemoryTicketRepository();
    const ticket = await repo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    expect((await repo.getBySequenceNumber(ticket.sequenceNumber))!.clientMessagesReadAt).toBeNull();

    const at = new Date('2020-01-01T00:00:00.000Z');
    await repo.markMessagesRead(ticket.id, 'client', at);

    const reloaded = await repo.getBySequenceNumber(ticket.sequenceNumber);
    expect(reloaded!.clientMessagesReadAt).toBe(at.toISOString());
  });

  it('los dos cursores (client/staff) son independientes — retroceder uno no toca al otro', async () => {
    const repo = new InMemoryTicketRepository();
    const ticket = await repo.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    await repo.markMessagesRead(ticket.id, 'client', new Date('2026-01-01T00:10:00.000Z'));
    await repo.markMessagesRead(ticket.id, 'staff', new Date('2026-01-01T00:20:00.000Z'));
    await repo.markMessagesRead(ticket.id, 'staff', new Date('2026-01-01T00:01:00.000Z')); // viejo, no debe retroceder staff

    const reloaded = await repo.getBySequenceNumber(ticket.sequenceNumber);
    expect(reloaded!.clientMessagesReadAt).toBe('2026-01-01T00:10:00.000Z');
    expect(reloaded!.staffMessagesReadAt).toBe('2026-01-01T00:20:00.000Z');
  });
});
