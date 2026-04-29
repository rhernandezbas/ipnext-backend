import { Admin, AdminActivityLog, ActivityCategory, Admin2FA } from '../entities/admin';

export interface AdminRepository {
  findAll(): Promise<Admin[]>;
  findById(id: string): Promise<Admin | null>;
  create(data: Omit<Admin, 'id' | 'createdAt' | 'lastLogin'>): Promise<Admin>;
  update(id: string, data: Partial<Admin>): Promise<Admin | null>;
  delete(id: string): Promise<boolean>;
  getActivityLog(category?: ActivityCategory): Promise<AdminActivityLog[]>;
  get2FAStatus(adminId: string): Promise<Admin2FA>;
  enable2FA(adminId: string, method: 'totp' | 'sms'): Promise<{ qrCode: string; backupCodes: string[] }>;
  disable2FA(adminId: string): Promise<boolean>;
}
