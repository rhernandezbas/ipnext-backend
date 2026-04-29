import { SearchResult, SearchResponse } from '@domain/entities/search';

interface SearchableAdmin {
  id: string;
  name: string;
  email: string;
  role?: string;
}

interface SearchableLead {
  id: string;
  name: string;
  email?: string;
  status?: string;
}

interface SearchableNas {
  id: string;
  name: string;
  ip?: string;
  ipAddress?: string;
}

interface GlobalSearchRepositories {
  findAdmins(): Promise<SearchableAdmin[]>;
  findLeads(): Promise<SearchableLead[]>;
  findNasDevices(): Promise<SearchableNas[]>;
}

// Inline seed data for cross-entity search
const SEEDED_CLIENTS: Array<{ id: string; name: string; email: string; status: string }> = [
  { id: 'client-1', name: 'Carlos Rodríguez', email: 'carlos@email.com', status: 'active' },
  { id: 'client-2', name: 'Ana Torres', email: 'ana.torres@email.com', status: 'active' },
  { id: 'client-3', name: 'Jorge López', email: 'jorge.lopez@email.com', status: 'blocked' },
  { id: 'client-4', name: 'María García', email: 'maria.garcia@email.com', status: 'active' },
  { id: 'client-5', name: 'Luis Fernández', email: 'luis.fernandez@email.com', status: 'active' },
  { id: 'client-6', name: 'Pedro Martínez', email: 'pedro.martinez@email.com', status: 'inactive' },
];

const SEEDED_TICKETS: Array<{ id: string; subject: string; clientName: string; status: string }> = [
  { id: 'ticket-1', subject: 'Sin conexión a internet', clientName: 'Carlos Rodríguez', status: 'open' },
  { id: 'ticket-2', subject: 'Lentitud en la red', clientName: 'Ana Torres', status: 'in_progress' },
  { id: 'ticket-3', subject: 'Falla de dispositivo', clientName: 'Jorge López', status: 'resolved' },
  { id: 'ticket-4', subject: 'Consulta de facturación', clientName: 'María García', status: 'open' },
];

const SEEDED_INVOICES: Array<{ id: string; number: string; clientName: string; amount: number }> = [
  { id: 'inv-1', number: 'F-0001', clientName: 'Carlos Rodríguez', amount: 3500 },
  { id: 'inv-2', number: 'F-0002', clientName: 'Ana Torres', amount: 2800 },
  { id: 'inv-3', number: 'F-0003', clientName: 'Jorge López', amount: 4200 },
];

const SEEDED_NAS: Array<{ id: string; name: string; ip: string }> = [
  { id: 'nas-1', name: 'NAS-Central-01', ip: '192.168.1.1' },
  { id: 'nas-2', name: 'NAS-Norte-02', ip: '192.168.1.2' },
  { id: 'nas-3', name: 'NAS-Sur-03', ip: '192.168.1.3' },
  { id: 'nas-4', name: 'NAS-Oeste-04', ip: '192.168.1.4' },
];

const SEEDED_ADMINS: Array<{ id: string; name: string; email: string; role: string }> = [
  { id: 'admin-1', name: 'Super Admin', email: 'admin@ipnext.com.ar', role: 'superadmin' },
  { id: 'admin-2', name: 'Carlos López', email: 'carlos@ipnext.com.ar', role: 'admin' },
  { id: 'admin-3', name: 'María Fernández', email: 'maria@ipnext.com.ar', role: 'viewer' },
];

const SEEDED_LEADS: Array<{ id: string; name: string; email: string; status: string }> = [
  { id: 'lead-1', name: 'Federico Álvarez', email: 'federico.alvarez@gmail.com', status: 'new' },
  { id: 'lead-2', name: 'Valeria Moreno', email: 'valeria.moreno@hotmail.com', status: 'contacted' },
  { id: 'lead-3', name: 'Roberto Silva', email: 'roberto.silva@gmail.com', status: 'qualified' },
];

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function scoreMatch(text: string, query: string): number {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  if (lower === q) return 3;
  if (lower.startsWith(q)) return 2;
  if (lower.includes(q)) return 1;
  return 0;
}

export class GlobalSearch {
  execute(query: string): SearchResponse {
    if (!query || query.trim().length < 2) {
      return { query, total: 0, results: [] };
    }

    const results: Array<SearchResult & { score: number }> = [];

    // Clients
    for (const c of SEEDED_CLIENTS) {
      if (matches(c.name, query) || matches(c.email, query)) {
        const score = Math.max(scoreMatch(c.name, query), scoreMatch(c.email, query));
        results.push({
          id: c.id,
          type: 'client',
          title: c.name,
          subtitle: c.email,
          href: `/admin/customers/view?id=${c.id}`,
          icon: '👤',
          score,
        });
      }
    }

    // Tickets
    for (const t of SEEDED_TICKETS) {
      if (matches(t.subject, query) || matches(t.clientName, query)) {
        const score = Math.max(scoreMatch(t.subject, query), scoreMatch(t.clientName, query));
        results.push({
          id: t.id,
          type: 'ticket',
          title: t.subject,
          subtitle: t.clientName,
          href: `/admin/tickets?id=${t.id}`,
          icon: '🎫',
          score,
        });
      }
    }

    // Invoices
    for (const inv of SEEDED_INVOICES) {
      if (matches(inv.number, query) || matches(inv.clientName, query)) {
        const score = Math.max(scoreMatch(inv.number, query), scoreMatch(inv.clientName, query));
        results.push({
          id: inv.id,
          type: 'invoice',
          title: inv.number,
          subtitle: inv.clientName,
          href: `/admin/finance/invoices?id=${inv.id}`,
          icon: '📄',
          score,
        });
      }
    }

    // NAS Devices
    for (const nas of SEEDED_NAS) {
      if (matches(nas.name, query) || matches(nas.ip, query)) {
        const score = Math.max(scoreMatch(nas.name, query), scoreMatch(nas.ip, query));
        results.push({
          id: nas.id,
          type: 'device',
          title: nas.name,
          subtitle: nas.ip,
          href: `/admin/networking/routers/list?id=${nas.id}`,
          icon: '🖥️',
          score,
        });
      }
    }

    // Admins
    for (const a of SEEDED_ADMINS) {
      if (matches(a.name, query) || matches(a.email, query) || matches(a.role, query)) {
        const score = Math.max(
          scoreMatch(a.name, query),
          scoreMatch(a.email, query),
          scoreMatch(a.role, query),
        );
        results.push({
          id: a.id,
          type: 'admin',
          title: a.name,
          subtitle: a.email,
          href: `/admin/administration/administrators?id=${a.id}`,
          icon: '🔧',
          score,
        });
      }
    }

    // Leads
    for (const l of SEEDED_LEADS) {
      if (matches(l.name, query) || matches(l.email, query)) {
        const score = Math.max(scoreMatch(l.name, query), scoreMatch(l.email, query));
        results.push({
          id: l.id,
          type: 'lead',
          title: l.name,
          subtitle: l.email,
          href: `/admin/leads?id=${l.id}`,
          icon: '🎯',
          score,
        });
      }
    }

    // Sort by score descending, then limit to 10
    results.sort((a, b) => b.score - a.score);
    const limited = results.slice(0, 10).map(({ score: _score, ...r }) => r);

    return {
      query,
      total: limited.length,
      results: limited,
    };
  }
}
