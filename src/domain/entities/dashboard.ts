export interface DashboardStats {
  newClientsThisMonth: number;
  activeClients: number;
  openTickets: number;
  pendingTickets: number;
  unresponsiveDevices: number;
  onlineDevices: number;
  revenueThisMonth: number;
  unpaidInvoices: number;
  overdueInvoices: number;
  cpuUsage: number;         // percentage 0-100
  ramUsage: number;         // percentage 0-100
  diskUsage: number;        // percentage 0-100
  uptime: string;           // e.g. "15 días, 4 horas"
}

export interface DashboardShortcut {
  id: string;
  label: string;
  icon: string;             // emoji or short name
  href: string;
  color: string;            // CSS color
}

export interface RecentActivity {
  id: string;
  type: 'client_added' | 'ticket_opened' | 'invoice_paid' | 'device_offline' | 'payment_received';
  description: string;
  timestamp: string;
  link: string;
}
