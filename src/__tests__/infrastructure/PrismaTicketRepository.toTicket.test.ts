import { toTicket } from '../../infrastructure/adapters/prisma/PrismaTicketRepository';

// Phase 2: status is now a relation object { name: string } from the DB.
const baseRow = {
  id: 'ticket-1',
  subject: 'Sin señal',
  description: 'No hay Internet',
  status: { name: 'open' },   // Phase 2: relation, not a bare string
  statusId: 'catalog-id-1',
  priority: 'high',
  customerId: 'client-1',
  customer: { id: 'client-1', name: 'Alice García' },
  assigneeId: 'admin-1',
  assignee: { id: 'admin-1', name: 'Tech Support' },
  reporterId: 'admin-2',
  reporter: { id: 'admin-2', name: 'Reporter Person' },
  grCasoId: null,
  createdAt: new Date('2024-01-01T10:00:00Z'),
  updatedAt: new Date('2024-01-02T10:00:00Z'),
};

describe('toTicket mapper', () => {
  it('maps all scalar fields', () => {
    const ticket = toTicket(baseRow);
    expect(ticket.id).toBe('ticket-1');
    expect(ticket.subject).toBe('Sin señal');
    expect(ticket.description).toBe('No hay Internet');
    expect(ticket.status).toBe('open');
    expect(ticket.priority).toBe('high');
  });

  it('Phase 2 contract: exposes status as the catalog NAME string (not the statusId)', () => {
    const ticket = toTicket(baseRow);
    // The API contract requires status to be the human-readable name
    expect(ticket.status).toBe('open');
    // statusId must NOT leak into the domain object
    expect((ticket as any).statusId).toBeUndefined();
  });

  it('Phase 2: maps any catalog status name correctly', () => {
    const pendingRow = { ...baseRow, status: { name: 'pending' } };
    expect(toTicket(pendingRow).status).toBe('pending');

    const closedRow = { ...baseRow, status: { name: 'closed' } };
    expect(toTicket(closedRow).status).toBe('closed');
  });

  it('derives customerName from JOIN only (not from free text)', () => {
    const ticket = toTicket(baseRow);
    expect(ticket.customerId).toBe('client-1');
    expect(ticket.customerName).toBe('Alice García');
  });

  it('returns customerName=null when customer relation is null', () => {
    const ticket = toTicket({ ...baseRow, customerId: null, customer: null });
    expect(ticket.customerId).toBeNull();
    expect(ticket.customerName).toBeNull();
  });

  it('derives assigneeName from JOIN only', () => {
    const ticket = toTicket(baseRow);
    expect(ticket.assigneeId).toBe('admin-1');
    expect(ticket.assigneeName).toBe('Tech Support');
  });

  it('returns assigneeName=null when assignee relation is null', () => {
    const ticket = toTicket({ ...baseRow, assigneeId: null, assignee: null });
    expect(ticket.assigneeId).toBeNull();
    expect(ticket.assigneeName).toBeNull();
  });

  it('#48: derives reporterName from JOIN only (mirror of assignee)', () => {
    const ticket = toTicket(baseRow);
    expect(ticket.reporterId).toBe('admin-2');
    expect(ticket.reporterName).toBe('Reporter Person');
  });

  it('#48: returns reporterName=null when reporter relation is null', () => {
    const ticket = toTicket({ ...baseRow, reporterId: null, reporter: null });
    expect(ticket.reporterId).toBeNull();
    expect(ticket.reporterName).toBeNull();
  });

  it('converts Date objects to ISO strings', () => {
    const ticket = toTicket(baseRow);
    expect(ticket.createdAt).toBe('2024-01-01T10:00:00.000Z');
    expect(ticket.updatedAt).toBe('2024-01-02T10:00:00.000Z');
  });

  it('passes through ISO string dates unchanged', () => {
    const ticket = toTicket({
      ...baseRow,
      createdAt: '2024-01-01T10:00:00.000Z',
      updatedAt: '2024-01-02T10:00:00.000Z',
    });
    expect(ticket.createdAt).toBe('2024-01-01T10:00:00.000Z');
    expect(ticket.updatedAt).toBe('2024-01-02T10:00:00.000Z');
  });
});
