import { SystemSettings, EmailSettings, MessageTemplate, ApiToken, FinanceSettings, PaymentMethod, Webhook, WebhookEvent, BackupRecord, ClientPortalSettings } from '../entities/settings';

export interface SettingsRepository {
  getSystemSettings(): Promise<SystemSettings>;
  updateSystemSettings(data: Partial<SystemSettings>): Promise<SystemSettings>;
  getEmailSettings(): Promise<EmailSettings>;
  updateEmailSettings(data: Partial<EmailSettings>): Promise<EmailSettings>;
  getTemplates(): Promise<MessageTemplate[]>;
  getTemplate(id: string): Promise<MessageTemplate | null>;
  updateTemplate(id: string, data: Partial<MessageTemplate>): Promise<MessageTemplate | null>;
  getApiTokens(): Promise<ApiToken[]>;
  createApiToken(name: string, permissions: string[]): Promise<ApiToken>;
  revokeApiToken(id: string): Promise<boolean>;
  getFinanceSettings(): Promise<FinanceSettings>;
  updateFinanceSettings(data: Partial<FinanceSettings>): Promise<FinanceSettings>;
  getPaymentMethods(): Promise<PaymentMethod[]>;
  createPaymentMethod(data: Omit<PaymentMethod, 'id'>): Promise<PaymentMethod>;
  updatePaymentMethod(id: string, data: Partial<PaymentMethod>): Promise<PaymentMethod | null>;
  deletePaymentMethod(id: string): Promise<boolean>;
  // Webhooks
  getWebhooks(): Promise<Webhook[]>;
  createWebhook(data: Omit<Webhook, 'id' | 'createdAt' | 'lastTriggered' | 'lastStatus'>): Promise<Webhook>;
  updateWebhook(id: string, data: Partial<Webhook>): Promise<Webhook | null>;
  deleteWebhook(id: string): Promise<boolean>;
  testWebhook(id: string): Promise<{ success: boolean }>;
  // Backups
  getBackups(): Promise<BackupRecord[]>;
  createBackup(): Promise<BackupRecord>;
  deleteBackup(id: string): Promise<boolean>;
  // Client Portal
  getClientPortalSettings(): Promise<ClientPortalSettings>;
  updateClientPortalSettings(data: Partial<ClientPortalSettings>): Promise<ClientPortalSettings>;
}
