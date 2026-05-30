import { Admin, Admin2FA } from '@domain/entities/admin';
import { AdminRepository, CreateAdminInput } from '@domain/ports/AdminRepository';
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

const twoFAStatuses: Map<string, Admin2FA> = new Map();

export class PrismaAdminRepository implements AdminRepository {
  async findAll(role?: string): Promise<Admin[]> {
    const rows = await prisma.admin.findMany({
      where: role ? { role: role as never } : undefined,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toAdmin);
  }

  async findById(id: string): Promise<Admin | null> {
    const row = await prisma.admin.findUnique({ where: { id } });
    return row ? toAdmin(row) : null;
  }

  async create(data: CreateAdminInput): Promise<Admin> {
    const row = await prisma.admin.create({
      data: {
        name: data.name,
        email: data.email,
        role: data.role as any,
        status: data.status as any,
        ...(data.passwordHash !== null && { passwordHash: data.passwordHash }),
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
