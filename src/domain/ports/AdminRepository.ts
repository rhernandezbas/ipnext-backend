import { Admin, AdminActivityLog, ActivityCategory, Admin2FA } from '../entities/admin';

export interface CreateAdminInput extends Omit<Admin, 'id' | 'createdAt' | 'lastLogin'> {
  /** bcrypt hash of the admin password. Null when no password is set. */
  passwordHash: string | null;
}

export interface AdminRepository {
  findAll(role?: string): Promise<Admin[]>;
  findById(id: string): Promise<Admin | null>;
  create(data: CreateAdminInput): Promise<Admin>;
  update(id: string, data: Partial<Admin>): Promise<Admin | null>;
  delete(id: string): Promise<boolean>;
  getActivityLog(category?: ActivityCategory): Promise<AdminActivityLog[]>;
  get2FAStatus(adminId: string): Promise<Admin2FA>;
  enable2FA(adminId: string, method: 'totp' | 'sms'): Promise<{ qrCode: string; backupCodes: string[] }>;
  disable2FA(adminId: string): Promise<boolean>;
}
