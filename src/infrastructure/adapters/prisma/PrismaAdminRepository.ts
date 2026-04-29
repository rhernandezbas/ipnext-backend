import { Admin, AdminActivityLog, ActivityCategory, Admin2FA } from '@domain/entities/admin';
import { AdminRepository } from '@domain/ports/AdminRepository';
import { prisma } from '../../database/prisma';
import crypto from 'crypto';

function toAdmin(row: any): Admin {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as Admin['role'],
    status: row.status as Admin['status'],
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    lastLogin: row.lastLogin
      ? row.lastLogin instanceof Date ? row.lastLogin.toISOString() : row.lastLogin
      : null,
  };
}

function toActivityLog(row: any): AdminActivityLog {
  return {
    id: row.id,
    adminId: row.adminId,
    adminName: '',  // not stored in Prisma model, resolved at read time if needed
    category: row.category as ActivityCategory,
    action: row.action,
    details: row.details ?? undefined,
    ip: row.ip ?? undefined,
    timestamp: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

const twoFAStatuses: Map<string, Admin2FA> = new Map();

export class InMemoryAdminRepository implements AdminRepository {
  async findAll(): Promise<Admin[]> {
    const rows = await prisma.admin.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toAdmin);
  }

  async findById(id: string): Promise<Admin | null> {
    const row = await prisma.admin.findUnique({ where: { id } });
    return row ? toAdmin(row) : null;
  }

  async create(data: Omit<Admin, 'id' | 'createdAt' | 'lastLogin'>): Promise<Admin> {
    const row = await prisma.admin.create({
      data: {
        name: data.name,
        email: data.email,
        role: data.role as any,
        status: data.status as any,
      },
    });
    return toAdmin(row);
  }

  async update(id: string, data: Partial<Admin>): Promise<Admin | null> {
    try {
      const row = await prisma.admin.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.email !== undefined && { email: data.email }),
          ...(data.role !== undefined && { role: data.role as any }),
          ...(data.status !== undefined && { status: data.status as any }),
          ...(data.lastLogin !== undefined && {
            lastLogin: data.lastLogin ? new Date(data.lastLogin) : null,
          }),
        },
      });
      return toAdmin(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await prisma.admin.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async getActivityLog(category?: ActivityCategory): Promise<AdminActivityLog[]> {
    const rows = await prisma.adminActivityLog.findMany({
      where: category ? { category } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { admin: { select: { name: true } } },
    });
    return rows.map(row => ({
      id: row.id,
      adminId: row.adminId,
      adminName: (row as any).admin?.name ?? '',
      category: row.category as ActivityCategory,
      action: row.action,
      details: row.details ?? '',
      ip: row.ip ?? '',
      timestamp: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    }));
  }

  async get2FAStatus(adminId: string): Promise<Admin2FA> {
    const existing = twoFAStatuses.get(adminId);
    if (existing) return { ...existing };
    const admin = await prisma.admin.findUnique({ where: { id: adminId } });
    if (admin?.twoFaEnabled) {
      return {
        adminId,
        enabled: true,
        method: 'totp',
        backupCodesCount: 8,
        enabledAt: admin.updatedAt instanceof Date ? admin.updatedAt.toISOString() : null,
        lastUsedAt: null,
      };
    }
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
      crypto.randomBytes(3).toString('hex').toUpperCase(),
    );
    const secret = crypto.randomBytes(20).toString('base64');
    await prisma.admin.update({
      where: { id: adminId },
      data: { twoFaEnabled: true, twoFaSecret: secret },
    });
    const status: Admin2FA = {
      adminId,
      enabled: true,
      method,
      backupCodesCount: backupCodes.length,
      enabledAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    twoFAStatuses.set(adminId, status);
    return {
      qrCode: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      backupCodes,
    };
  }

  async disable2FA(adminId: string): Promise<boolean> {
    try {
      await prisma.admin.update({
        where: { id: adminId },
        data: { twoFaEnabled: false, twoFaSecret: null },
      });
      twoFAStatuses.delete(adminId);
      return true;
    } catch {
      return false;
    }
  }
}
