import { DashboardRepository } from '@domain/ports/DashboardRepository';
import { DashboardStats, DashboardShortcut, RecentActivity } from '@domain/entities/dashboard';
import { sharedClientStore, sharedTicketStore } from './shared-stores';

const SHORTCUTS: DashboardShortcut[] = [
  { id: '1', label: 'Nuevo cliente', icon: '👤', href: '/admin/crm/clientes', color: '#2563eb' },
  { id: '2', label: 'Nuevo ticket', icon: '🎫', href: '/admin/crm/tickets/new', color: '#f59e0b' },
  { id: '3', label: 'Facturación', icon: '💰', href: '/admin/crm/finanzas', color: '#10b981' },
  { id: '4', label: 'Red', icon: '📡', href: '/admin/empresa/red', color: '#6366f1' },
  { id: '5', label: 'Leads', icon: '🌟', href: '/admin/crm/leads', color: '#ec4899' },
];

const ACTIVITY: RecentActivity[] = [
  {
    id: '1',
    type: 'client_added',
    description: 'Nuevo cliente: María González agregada',
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    link: '/admin/crm/clientes',
  },
  {
    id: '2',
    type: 'ticket_opened',
    description: 'Ticket #1042 abierto: Sin conexión en zona norte',
    timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
    link: '/admin/crm/tickets',
  },
  {
    id: '3',
    type: 'payment_received',
    description: 'Pago recibido: $3.500 de Carlos Rodríguez',
    timestamp: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
    link: '/admin/crm/finanzas/pagos',
  },
  {
    id: '4',
    type: 'device_offline',
    description: 'Dispositivo sin respuesta: Router MK-A12 (Palermo)',
    timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    link: '/admin/empresa/red',
  },
  {
    id: '5',
    type: 'invoice_paid',
    description: 'Factura #3892 pagada por Ana Torres',
    timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
    link: '/admin/crm/finanzas/facturas',
  },
  {
    id: '6',
    type: 'client_added',
    description: 'Nuevo cliente: Jorge Fernández agregado',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    link: '/admin/crm/clientes',
  },
  {
    id: '7',
    type: 'ticket_opened',
    description: 'Ticket #1041 abierto: Velocidad baja en zona sur',
    timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    link: '/admin/crm/tickets',
  },
  {
    id: '8',
    type: 'payment_received',
    description: 'Pago recibido: $5.200 de Luis Pérez',
    timestamp: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    link: '/admin/crm/finanzas/pagos',
  },
  {
    id: '9',
    type: 'device_offline',
    description: 'Dispositivo sin respuesta: Switch SW-003 (Belgrano)',
    timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    link: '/admin/empresa/red',
  },
  {
    id: '10',
    type: 'invoice_paid',
    description: 'Factura #3885 pagada por Roberto Sánchez',
    timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    link: '/admin/crm/finanzas/facturas',
  },
];

export class InMemoryDashboardRepository implements DashboardRepository {
  async getStats(): Promise<DashboardStats> {
    return {
      newClientsThisMonth: sharedClientStore.newThisMonth,
      activeClients: sharedClientStore.activeCount,
      openTickets: sharedTicketStore.openCount,
      pendingTickets: sharedTicketStore.pendingCount,
      unresponsiveDevices: 12,
      onlineDevices: 248,
      revenueThisMonth: 4850000,
      unpaidInvoices: 89,
      overdueInvoices: 34,
      cpuUsage: 23,
      ramUsage: 61,
      diskUsage: 45,
      uptime: '15 días, 4 horas',
    };
  }

  async getShortcuts(): Promise<DashboardShortcut[]> {
    return [...SHORTCUTS];
  }

  async getRecentActivity(): Promise<RecentActivity[]> {
    return [...ACTIVITY];
  }
}
