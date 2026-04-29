import {
  SystemSettings,
  EmailSettings,
  MessageTemplate,
  ApiToken,
  FinanceSettings,
  PaymentMethod,
  Webhook,
  BackupRecord,
  ClientPortalSettings,
} from '@domain/entities/settings';
import { SettingsRepository } from '@domain/ports/SettingsRepository';
import { prisma } from '../../database/prisma';
import crypto from 'crypto';

function toSystemSettings(row: any): SystemSettings {
  return {
    companyName: row.companyName,
    timezone: row.timezone,
    currency: row.currency,
    language: row.language,
    dateFormat: row.dateFormat,
    invoicePrefix: row.invoicePrefix,
    supportEmail: row.supportEmail ?? undefined,
    website: row.website ?? undefined,
  };
}

function toEmailSettings(row: any): EmailSettings {
  return {
    smtpHost: row.smtpHost ?? undefined,
    smtpPort: row.smtpPort,
    smtpUser: row.smtpUser ?? undefined,
    smtpPassword: row.smtpPassword ?? undefined,
    fromName: row.fromName ?? undefined,
    fromEmail: row.fromEmail ?? undefined,
    useTls: row.useTls,
  };
}

function toTemplate(row: any): MessageTemplate {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    subject: row.subject ?? undefined,
    body: row.body,
    variables: row.variables as any,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

function toApiToken(row: any): ApiToken {
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    permissions: row.permissions as string[],
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    lastUsed: row.lastUsed
      ? (row.lastUsed instanceof Date ? row.lastUsed.toISOString() : row.lastUsed)
      : null,
  };
}

function toPaymentMethod(row: any): PaymentMethod {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    config: row.config as any,
  };
}

function toWebhook(row: any): Webhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events as any,
    secret: row.secret ?? undefined,
    status: row.status as Webhook['status'],
    lastTriggered: row.lastTriggered
      ? (row.lastTriggered instanceof Date ? row.lastTriggered.toISOString() : row.lastTriggered)
      : null,
    lastStatus: row.lastStatus ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

function toBackupRecord(row: any): BackupRecord {
  return {
    id: row.id,
    filename: row.filename,
    size: row.sizeBytes,
    type: row.type as BackupRecord['type'],
    status: row.status as BackupRecord['status'],
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    downloadUrl: row.downloadUrl ?? undefined,
  };
}

function toPortalSettings(row: any): ClientPortalSettings {
  return {
    enabled: row.enabled,
    portalUrl: row.portalUrl ?? undefined,
    allowSelfRegistration: row.allowSelfRegistration,
    requireEmailVerification: row.requireEmailVerification,
    allowPaymentOnline: row.allowPaymentOnline,
    allowTicketCreation: row.allowTicketCreation,
    allowServiceManagement: row.allowServiceManagement,
    welcomeMessage: row.welcomeMessage ?? undefined,
    logoUrl: row.logoUrl ?? null,
    primaryColor: row.primaryColor,
    customCss: row.customCss ?? undefined,
  };
}

export class InMemorySettingsRepository implements SettingsRepository {
  async getSystemSettings(): Promise<SystemSettings> {
    let row = await prisma.systemSettings.findUnique({ where: { id: 'singleton' } });
    if (!row) {
      row = await prisma.systemSettings.create({
        data: { id: 'singleton' },
      });
    }
    return toSystemSettings(row);
  }

  async updateSystemSettings(data: Partial<SystemSettings>): Promise<SystemSettings> {
    const row = await prisma.systemSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data } as any,
      update: data as any,
    });
    return toSystemSettings(row);
  }

  async getEmailSettings(): Promise<EmailSettings> {
    let row = await prisma.emailSettings.findUnique({ where: { id: 'singleton' } });
    if (!row) {
      row = await prisma.emailSettings.create({ data: { id: 'singleton' } });
    }
    return toEmailSettings(row);
  }

  async updateEmailSettings(data: Partial<EmailSettings>): Promise<EmailSettings> {
    const row = await prisma.emailSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data } as any,
      update: data as any,
    });
    return toEmailSettings(row);
  }

  async getTemplates(): Promise<MessageTemplate[]> {
    const rows = await prisma.messageTemplate.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toTemplate);
  }

  async getTemplate(id: string): Promise<MessageTemplate | null> {
    const row = await prisma.messageTemplate.findUnique({ where: { id } });
    return row ? toTemplate(row) : null;
  }

  async updateTemplate(id: string, data: Partial<MessageTemplate>): Promise<MessageTemplate | null> {
    try {
      const row = await prisma.messageTemplate.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.subject !== undefined && { subject: data.subject }),
          ...(data.body !== undefined && { body: data.body }),
          ...(data.variables !== undefined && { variables: data.variables as any }),
        },
      });
      return toTemplate(row);
    } catch {
      return null;
    }
  }

  async getApiTokens(): Promise<ApiToken[]> {
    const rows = await prisma.apiToken.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toApiToken);
  }

  async createApiToken(name: string, permissions: string[]): Promise<ApiToken> {
    const rawToken = crypto.randomBytes(16).toString('hex');
    const masked = `••••••••${rawToken.slice(-4)}`;
    const row = await prisma.apiToken.create({
      data: {
        name,
        token: masked,
        permissions,
      },
    });
    return toApiToken(row);
  }

  async revokeApiToken(id: string): Promise<boolean> {
    try {
      await prisma.apiToken.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async getFinanceSettings(): Promise<FinanceSettings> {
    const row = await prisma.financeSettings.upsert({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton' },
    });
    const methods = await this.getPaymentMethods();
    return {
      invoiceDueDays: row.invoiceDueDays,
      taxName: row.taxName,
      taxRate: row.taxRate,
      taxIncluded: row.taxIncluded,
      autoGenerateInvoices: row.autoGenerateInvoices,
      invoiceDay: row.invoiceDay,
      lateFeeEnabled: row.lateFeeEnabled,
      lateFeeAmount: row.lateFeeAmount,
      lateFeeDays: row.lateFeeDays,
      reminderDays: row.reminderDays as number[],
      currency: row.currency,
      currencySymbol: row.currencySymbol,
      paymentMethods: methods,
    };
  }

  async updateFinanceSettings(data: Partial<FinanceSettings>): Promise<FinanceSettings> {
    const { paymentMethods: _, ...rest } = data;
    const row = await prisma.financeSettings.upsert({
      where: { id: 'singleton' },
      update: rest as any,
      create: { id: 'singleton', ...rest } as any,
    });
    const methods = await this.getPaymentMethods();
    return {
      invoiceDueDays: row.invoiceDueDays,
      taxName: row.taxName,
      taxRate: row.taxRate,
      taxIncluded: row.taxIncluded,
      autoGenerateInvoices: row.autoGenerateInvoices,
      invoiceDay: row.invoiceDay,
      lateFeeEnabled: row.lateFeeEnabled,
      lateFeeAmount: row.lateFeeAmount,
      lateFeeDays: row.lateFeeDays,
      reminderDays: row.reminderDays as number[],
      currency: row.currency,
      currencySymbol: row.currencySymbol,
      paymentMethods: methods,
    };
  }

  async getPaymentMethods(): Promise<PaymentMethod[]> {
    const rows = await prisma.paymentMethod.findMany();
    return rows.map(toPaymentMethod);
  }

  async createPaymentMethod(data: Omit<PaymentMethod, 'id'>): Promise<PaymentMethod> {
    const row = await prisma.paymentMethod.create({
      data: {
        name: data.name,
        type: data.type,
        enabled: data.enabled,
        config: data.config as any,
      },
    });
    return toPaymentMethod(row);
  }

  async updatePaymentMethod(id: string, data: Partial<PaymentMethod>): Promise<PaymentMethod | null> {
    try {
      const row = await prisma.paymentMethod.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.type !== undefined && { type: data.type }),
          ...(data.enabled !== undefined && { enabled: data.enabled }),
          ...(data.config !== undefined && { config: data.config as any }),
        },
      });
      return toPaymentMethod(row);
    } catch {
      return null;
    }
  }

  async deletePaymentMethod(id: string): Promise<boolean> {
    try {
      await prisma.paymentMethod.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async getWebhooks(): Promise<Webhook[]> {
    const rows = await prisma.webhook.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(toWebhook);
  }

  async createWebhook(
    data: Omit<Webhook, 'id' | 'createdAt' | 'lastTriggered' | 'lastStatus'>,
  ): Promise<Webhook> {
    const row = await prisma.webhook.create({
      data: {
        name: data.name,
        url: data.url,
        events: data.events as any,
        secret: data.secret ?? null,
        status: data.status,
      },
    });
    return toWebhook(row);
  }

  async updateWebhook(id: string, data: Partial<Webhook>): Promise<Webhook | null> {
    try {
      const row = await prisma.webhook.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.url !== undefined && { url: data.url }),
          ...(data.events !== undefined && { events: data.events as any }),
          ...(data.secret !== undefined && { secret: data.secret }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.lastTriggered !== undefined && {
            lastTriggered: data.lastTriggered ? new Date(data.lastTriggered) : null,
          }),
          ...(data.lastStatus !== undefined && { lastStatus: data.lastStatus }),
        },
      });
      return toWebhook(row);
    } catch {
      return null;
    }
  }

  async deleteWebhook(id: string): Promise<boolean> {
    try {
      await prisma.webhook.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async testWebhook(id: string): Promise<{ success: boolean }> {
    const webhook = await prisma.webhook.findUnique({ where: { id } });
    if (!webhook) return { success: false };
    await prisma.webhook.update({
      where: { id },
      data: { lastTriggered: new Date(), lastStatus: 'success' },
    });
    return { success: true };
  }

  async getBackups(): Promise<BackupRecord[]> {
    const rows = await prisma.backupRecord.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toBackupRecord);
  }

  async createBackup(): Promise<BackupRecord> {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);
    const row = await prisma.backupRecord.create({
      data: {
        filename: `backup-${datePart}-manual.tar.gz`,
        sizeBytes: 0,
        type: 'manual',
        status: 'in_progress',
        downloadUrl: null,
      },
    });
    return toBackupRecord(row);
  }

  async deleteBackup(id: string): Promise<boolean> {
    try {
      await prisma.backupRecord.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async getClientPortalSettings(): Promise<ClientPortalSettings> {
    let row = await prisma.clientPortalSettings.findUnique({ where: { id: 'singleton' } });
    if (!row) {
      row = await prisma.clientPortalSettings.create({ data: { id: 'singleton' } });
    }
    return toPortalSettings(row);
  }

  async updateClientPortalSettings(data: Partial<ClientPortalSettings>): Promise<ClientPortalSettings> {
    const row = await prisma.clientPortalSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...data } as any,
      update: data as any,
    });
    return toPortalSettings(row);
  }
}
