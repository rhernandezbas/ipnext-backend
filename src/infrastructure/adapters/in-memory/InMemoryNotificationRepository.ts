import { Notification } from '@domain/entities/notification';
import { NotificationRepository } from '@domain/ports/NotificationRepository';

const SEED: Notification[] = [
  {
    id: 'notif-1',
    type: 'device_offline',
    title: 'Dispositivo sin conexión',
    message: 'CPE-Cliente-Torres dejó de responder hace más de 1 hora.',
    severity: 'error',
    read: false,
    link: '/admin/monitoring',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    readAt: null,
  },
  {
    id: 'notif-2',
    type: 'new_ticket',
    title: 'Nuevo ticket creado',
    message: 'Carlos Rodríguez abrió un ticket: "Sin conexión a internet".',
    severity: 'info',
    read: false,
    link: '/admin/tickets',
    createdAt: new Date(Date.now() - 1_800_000).toISOString(),
    readAt: null,
  },
  {
    id: 'notif-3',
    type: 'payment_received',
    title: 'Pago recibido',
    message: 'Ana Torres realizó un pago de $2.800.',
    severity: 'success',
    read: true,
    link: '/admin/finance/payments',
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    readAt: new Date(Date.now() - 6_000_000).toISOString(),
  },
  {
    id: 'notif-4',
    type: 'invoice_overdue',
    title: 'Factura vencida',
    message: 'La factura F-0003 de Jorge López está vencida desde hace 5 días.',
    severity: 'warning',
    read: false,
    link: '/admin/finance/invoices',
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    readAt: null,
  },
  {
    id: 'notif-5',
    type: 'device_recovered',
    title: 'Dispositivo recuperado',
    message: 'NAS-Norte-02 volvió a estar en línea.',
    severity: 'success',
    read: true,
    link: '/admin/monitoring',
    createdAt: new Date(Date.now() - 10_800_000).toISOString(),
    readAt: new Date(Date.now() - 10_000_000).toISOString(),
  },
  {
    id: 'notif-6',
    type: 'new_lead',
    title: 'Nuevo lead',
    message: 'Federico Álvarez completó el formulario de contacto.',
    severity: 'info',
    read: false,
    link: '/admin/leads',
    createdAt: new Date(Date.now() - 900_000).toISOString(),
    readAt: null,
  },
  {
    id: 'notif-7',
    type: 'low_stock',
    title: 'Stock bajo',
    message: 'Cable UTP Cat6 tiene menos de 10 unidades en stock.',
    severity: 'warning',
    read: true,
    link: '/admin/inventory/list',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    readAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 3600000).toISOString(),
  },
  {
    id: 'notif-8',
    type: 'ticket_resolved',
    title: 'Ticket resuelto',
    message: 'El ticket "Lentitud en la red" de Ana Torres fue resuelto.',
    severity: 'success',
    read: true,
    link: '/admin/tickets',
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    readAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000 + 1800000).toISOString(),
  },
  {
    id: 'notif-9',
    type: 'backup_completed',
    title: 'Backup completado',
    message: 'El backup diario se completó exitosamente.',
    severity: 'info',
    read: true,
    link: null,
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    readAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'notif-10',
    type: 'system_update',
    title: 'Actualización disponible',
    message: 'Hay una nueva versión del sistema disponible para instalar.',
    severity: 'info',
    read: true,
    link: '/admin/config/main',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    readAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 7200000).toISOString(),
  },
  {
    id: 'notif-11',
    type: 'device_offline',
    title: 'Dispositivo sin conexión',
    message: 'CPE-Cliente-Martinez dejó de responder hace más de 90 minutos.',
    severity: 'error',
    read: false,
    link: '/admin/monitoring',
    createdAt: new Date(Date.now() - 5_400_000).toISOString(),
    readAt: null,
  },
  {
    id: 'notif-12',
    type: 'payment_received',
    title: 'Pago recibido',
    message: 'Luis Fernández realizó un pago de $3.500.',
    severity: 'success',
    read: true,
    link: '/admin/finance/payments',
    createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
    readAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000 + 3600000).toISOString(),
  },
];

export class InMemoryNotificationRepository implements NotificationRepository {
  private notifications: Notification[] = SEED.map(n => ({ ...n }));

  async findAll(unreadOnly?: boolean): Promise<Notification[]> {
    if (unreadOnly) {
      return this.notifications.filter(n => !n.read);
    }
    return [...this.notifications];
  }

  async markAsRead(id: string): Promise<Notification | null> {
    const index = this.notifications.findIndex(n => n.id === id);
    if (index === -1) return null;
    this.notifications[index] = {
      ...this.notifications[index],
      read: true,
      readAt: new Date().toISOString(),
    };
    return this.notifications[index];
  }

  async markAllAsRead(): Promise<void> {
    const now = new Date().toISOString();
    this.notifications = this.notifications.map(n => ({
      ...n,
      read: true,
      readAt: n.readAt ?? now,
    }));
  }

  async delete(id: string): Promise<boolean> {
    const index = this.notifications.findIndex(n => n.id === id);
    if (index === -1) return false;
    this.notifications.splice(index, 1);
    return true;
  }
}
