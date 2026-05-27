import { Admin, AdminActivityLog, ActivityCategory, Admin2FA } from '@domain/entities/admin';
import { AdminRepository, CreateAdminInput } from '@domain/ports/AdminRepository';

let nextId = 4;

interface AdminRecord {
  admin: Admin;
  passwordHash: string | null;
}

export class InMemoryAdminRepository implements AdminRepository {
  private records: AdminRecord[] = [];

  // Expose passwordHash for testing purposes only
  async findByEmailWithHash(email: string): Promise<{ admin: Admin; passwordHash: string | null } | null> {
    const record = this.records.find(r => r.admin.email === email);
    return record ? { admin: record.admin, passwordHash: record.passwordHash } : null;
  }

  private get admins(): Admin[] {
    return this.records.map(r => r.admin);
  }

  constructor() {
    // Seed initial admins (no passwordHash for legacy seeded admins)
    const seeded: Admin[] = [
      {
        id: '1',
        name: 'Super Admin',
        email: 'admin@ipnext.com.ar',
        role: 'superadmin',
        status: 'active',
        createdAt: '2024-01-01T00:00:00Z',
        lastLogin: '2026-04-28T07:00:00Z',
      },
      {
        id: '2',
        name: 'Carlos López',
        email: 'carlos@ipnext.com.ar',
        role: 'admin',
        status: 'active',
        createdAt: '2024-03-15T00:00:00Z',
        lastLogin: '2026-04-27T15:30:00Z',
      },
      {
        id: '3',
        name: 'María Fernández',
        email: 'maria@ipnext.com.ar',
        role: 'viewer',
        status: 'inactive',
        createdAt: '2024-06-01T00:00:00Z',
        lastLogin: null,
      },
      {
        id: '4',
        name: 'Carlos Técnico',
        email: 'carlos@ipnext.com.ar',
        role: 'technician',
        status: 'active',
        createdAt: '2025-01-15T00:00:00Z',
        lastLogin: null,
      },
    ];
    this.records = seeded.map(admin => ({ admin, passwordHash: null }));
  }

  private activityLog: AdminActivityLog[] = [
    {
      id: 'log-1',
      adminId: '1',
      adminName: 'Super Admin',
      category: 'auth',
      action: 'Inicio de sesión',
      details: 'Sesión iniciada desde IP 192.168.1.1',
      ip: '192.168.1.1',
      timestamp: '2026-04-28T07:00:00Z',
    },
    {
      id: 'log-2',
      adminId: '2',
      adminName: 'Carlos López',
      category: 'clients',
      action: 'Creó cliente',
      details: 'Creó cliente ID 1001 - Juan Pérez',
      ip: '192.168.1.20',
      timestamp: '2026-04-27T16:00:00Z',
    },
    {
      id: 'log-3',
      adminId: '2',
      adminName: 'Carlos López',
      category: 'settings',
      action: 'Modificó tarifa',
      details: 'Modificó tarifa ID 5 - Plan Fibra 100MB',
      ip: '192.168.1.20',
      timestamp: '2026-04-27T15:45:00Z',
    },
    {
      id: 'log-4',
      adminId: '1',
      adminName: 'Super Admin',
      category: 'billing',
      action: 'Eliminó factura',
      details: 'Eliminó factura ID 203 - Factura vencida',
      ip: '192.168.1.1',
      timestamp: '2026-04-26T10:30:00Z',
    },
    {
      id: 'log-5',
      adminId: '1',
      adminName: 'Super Admin',
      category: 'admins',
      action: 'Creó administrador',
      details: 'Creó administrador Carlos López con rol admin',
      ip: '192.168.1.1',
      timestamp: '2024-03-15T00:05:00Z',
    },
    {
      id: 'log-6',
      adminId: '1',
      adminName: 'Super Admin',
      category: 'auth',
      action: 'Cerró sesión',
      details: 'Sesión cerrada correctamente',
      ip: '192.168.1.1',
      timestamp: '2026-04-27T18:00:00Z',
    },
    {
      id: 'log-7',
      adminId: '2',
      adminName: 'Carlos López',
      category: 'clients',
      action: 'Modificó cliente',
      details: 'Modificó dirección del cliente ID 1001',
      ip: '192.168.1.20',
      timestamp: '2026-04-27T14:00:00Z',
    },
    {
      id: 'log-8',
      adminId: '2',
      adminName: 'Carlos López',
      category: 'clients',
      action: 'Suspendió cliente',
      details: 'Suspendió cliente ID 1002 por mora',
      ip: '192.168.1.20',
      timestamp: '2026-04-26T09:00:00Z',
    },
    {
      id: 'log-9',
      adminId: '1',
      adminName: 'Super Admin',
      category: 'billing',
      action: 'Generó facturas',
      details: 'Generó 45 facturas del mes de abril',
      ip: '192.168.1.1',
      timestamp: '2026-04-01T06:00:00Z',
    },
    {
      id: 'log-10',
      adminId: '1',
      adminName: 'Super Admin',
      category: 'network',
      action: 'Reinició dispositivo',
      details: 'Reinició OLT Central por mantenimiento',
      ip: '192.168.1.1',
      timestamp: '2026-04-25T03:00:00Z',
    },
    {
      id: 'log-11',
      adminId: '1',
      adminName: 'Super Admin',
      category: 'settings',
      action: 'Modificó configuración SMTP',
      details: 'Actualizó servidor SMTP a smtp2.ipnext.com.ar',
      ip: '192.168.1.1',
      timestamp: '2026-04-20T11:00:00Z',
    },
    {
      id: 'log-12',
      adminId: '1',
      adminName: 'Super Admin',
      category: 'admins',
      action: 'Desactivó administrador',
      details: 'Desactivó administrador María Fernández',
      ip: '192.168.1.1',
      timestamp: '2026-04-15T10:00:00Z',
    },
  ];

  async findAll(role?: string): Promise<Admin[]> {
    const all = this.admins;
    return role ? all.filter(a => a.role === role) : [...all];
  }

  async findById(id: string): Promise<Admin | null> {
    return this.admins.find(a => a.id === id) ?? null;
  }

  async create(data: CreateAdminInput): Promise<Admin> {
    const { passwordHash, ...rest } = data;
    const admin: Admin = {
      ...rest,
      id: String(nextId++),
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };
    this.records.push({ admin, passwordHash });
    return admin;
  }

  async update(id: string, data: Partial<Admin>): Promise<Admin | null> {
    const index = this.records.findIndex(r => r.admin.id === id);
    if (index === -1) return null;
    this.records[index] = { ...this.records[index], admin: { ...this.records[index].admin, ...data } };
    return this.records[index].admin;
  }

  async delete(id: string): Promise<boolean> {
    const index = this.records.findIndex(r => r.admin.id === id);
    if (index === -1) return false;
    this.records.splice(index, 1);
    return true;
  }

  async getActivityLog(category?: ActivityCategory): Promise<AdminActivityLog[]> {
    if (category) {
      return this.activityLog.filter(l => l.category === category);
    }
    return [...this.activityLog];
  }

  private twoFAStatuses: Map<string, Admin2FA> = new Map();

  async get2FAStatus(adminId: string): Promise<Admin2FA> {
    const existing = this.twoFAStatuses.get(adminId);
    if (existing) return { ...existing };
    return {
      adminId,
      enabled: false,
      method: null,
      backupCodesCount: 0,
      enabledAt: null,
      lastUsedAt: null,
    };
  }

  async enable2FA(adminId: string, method: 'totp' | 'sms'): Promise<{ qrCode: string; backupCodes: string[] }> {
    const backupCodes = Array.from({ length: 8 }, () =>
      Math.random().toString(36).slice(2, 8).toUpperCase(),
    );
    const status: Admin2FA = {
      adminId,
      enabled: true,
      method,
      backupCodesCount: backupCodes.length,
      enabledAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.twoFAStatuses.set(adminId, status);
    return {
      qrCode: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      backupCodes,
    };
  }

  async disable2FA(adminId: string): Promise<boolean> {
    const status = this.twoFAStatuses.get(adminId);
    if (!status) {
      this.twoFAStatuses.set(adminId, {
        adminId,
        enabled: false,
        method: null,
        backupCodesCount: 0,
        enabledAt: null,
        lastUsedAt: null,
      });
      return true;
    }
    this.twoFAStatuses.set(adminId, { ...status, enabled: false, method: null });
    return true;
  }
}
