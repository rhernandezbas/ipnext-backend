export interface Admin {
  id: string;
  name: string;
  email: string;
  role: 'superadmin' | 'admin' | 'viewer';
  status: 'active' | 'inactive';
  createdAt: string;
  lastLogin: string | null;
}

export interface Admin2FA {
  adminId: string;
  enabled: boolean;
  method: 'totp' | 'sms' | null;
  backupCodesCount: number;
  enabledAt: string | null;
  lastUsedAt: string | null;
}

export type ActivityCategory = 'auth' | 'clients' | 'billing' | 'network' | 'scheduling' | 'settings' | 'admins' | 'api' | 'system';

export interface AdminActivityLog {
  id: string;
  adminId: string;
  adminName: string;
  category: ActivityCategory;
  action: string;
  details: string;
  ip: string;
  timestamp: string;
}
