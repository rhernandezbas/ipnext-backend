import { Message } from '@domain/entities/message';
import { MessageRepository } from '@domain/ports/MessageRepository';

let nextId = 9;

const SEED: Message[] = [
  {
    id: '1',
    subject: 'Bienvenido al sistema IPNEXT',
    body: 'Hola, bienvenido al sistema de gestión IPNEXT. Cualquier consulta no dudes en contactarnos.',
    fromId: 'admin-1',
    fromName: 'Admin Principal',
    toId: null,
    toName: null,
    clientId: null,
    channel: 'internal',
    status: 'unread',
    sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    threadId: null,
  },
  {
    id: '2',
    subject: 'Consulta sobre facturación',
    body: 'Hola, quisiera saber el estado de mi factura del mes pasado.',
    fromId: 'client-42',
    fromName: 'Carlos Rodríguez',
    toId: 'admin-1',
    toName: 'Admin Principal',
    clientId: 'client-42',
    channel: 'email',
    status: 'unread',
    sentAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    threadId: null,
  },
  {
    id: '3',
    subject: 'Problema de conexión reportado',
    body: 'El cliente reporta intermitencia en la conexión durante las últimas 24 horas.',
    fromId: 'admin-2',
    fromName: 'Soporte Técnico',
    toId: 'admin-1',
    toName: 'Admin Principal',
    clientId: null,
    channel: 'internal',
    status: 'read',
    sentAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    threadId: null,
  },
  {
    id: '4',
    subject: 'Notificación de mantenimiento',
    body: 'Se realizará mantenimiento programado el día 30 de abril de 02:00 a 04:00 hs.',
    fromId: 'admin-1',
    fromName: 'Admin Principal',
    toId: null,
    toName: null,
    clientId: null,
    channel: 'email',
    status: 'sent',
    sentAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    threadId: null,
  },
  {
    id: '5',
    subject: 'Respuesta a consulta #3892',
    body: 'Estimado cliente, su factura está disponible en el portal de autogestión.',
    fromId: 'admin-1',
    fromName: 'Admin Principal',
    toId: 'client-42',
    toName: 'Carlos Rodríguez',
    clientId: 'client-42',
    channel: 'email',
    status: 'sent',
    sentAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    threadId: '2',
  },
  {
    id: '6',
    subject: 'SMS de corte de servicio',
    body: 'Su servicio será suspendido por falta de pago. Por favor regularice su situación.',
    fromId: 'admin-1',
    fromName: 'Admin Principal',
    toId: 'client-15',
    toName: 'Ana Torres',
    clientId: 'client-15',
    channel: 'sms',
    status: 'sent',
    sentAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    threadId: null,
  },
  {
    id: '7',
    subject: 'Borrador: Campaña de fidelización',
    body: 'Estimados clientes, nos complace informarles que a partir del próximo mes...',
    fromId: 'admin-1',
    fromName: 'Admin Principal',
    toId: null,
    toName: null,
    clientId: null,
    channel: 'email',
    status: 'draft',
    sentAt: null,
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    threadId: null,
  },
  {
    id: '8',
    subject: 'Borrador: Aviso de aumento de tarifas',
    body: 'A partir del 1 de mayo los precios de los planes se actualizarán según inflación...',
    fromId: 'admin-1',
    fromName: 'Admin Principal',
    toId: null,
    toName: null,
    clientId: null,
    channel: 'email',
    status: 'draft',
    sentAt: null,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    threadId: null,
  },
];

export class InMemoryMessageRepository implements MessageRepository {
  private messages: Message[] = SEED.map(m => ({ ...m }));

  async findAll(filter?: 'inbox' | 'sent' | 'draft'): Promise<Message[]> {
    if (!filter) return [...this.messages];
    if (filter === 'inbox') return this.messages.filter(m => m.status === 'unread' || m.status === 'read');
    if (filter === 'sent') return this.messages.filter(m => m.status === 'sent');
    if (filter === 'draft') return this.messages.filter(m => m.status === 'draft');
    return [...this.messages];
  }

  async findById(id: string): Promise<Message | null> {
    return this.messages.find(m => m.id === id) ?? null;
  }

  async create(data: Omit<Message, 'id' | 'createdAt'>): Promise<Message> {
    const message: Message = {
      ...data,
      id: String(nextId++),
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    return message;
  }

  async markAsRead(id: string): Promise<Message | null> {
    const index = this.messages.findIndex(m => m.id === id);
    if (index === -1) return null;
    this.messages[index] = { ...this.messages[index], status: 'read' };
    return this.messages[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.messages.findIndex(m => m.id === id);
    if (index === -1) return false;
    this.messages.splice(index, 1);
    return true;
  }
}
