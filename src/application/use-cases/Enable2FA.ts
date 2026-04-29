import { AdminRepository } from '@domain/ports/AdminRepository';

export class Enable2FA {
  constructor(private readonly repo: AdminRepository) {}

  execute(adminId: string, method: 'totp' | 'sms'): Promise<{ qrCode: string; backupCodes: string[] }> {
    return this.repo.enable2FA(adminId, method);
  }
}
