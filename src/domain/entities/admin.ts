export interface Admin {
  id: string;
  name: string;
  email: string;
  role: string;   // role-definition name (editable, backed by AdminRoleDefinition)
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
