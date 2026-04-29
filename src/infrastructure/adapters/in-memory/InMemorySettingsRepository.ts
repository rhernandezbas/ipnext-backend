import { SystemSettings, EmailSettings, MessageTemplate, ApiToken, FinanceSettings, PaymentMethod, TemplateVariable, Webhook, WebhookEvent, BackupRecord, ClientPortalSettings } from '@domain/entities/settings';
import { SettingsRepository } from '@domain/ports/SettingsRepository';

let nextTokenId = 3;
let nextWebhookId = 4;
let nextBackupId = 6;

export class InMemorySettingsRepository implements SettingsRepository {
  private systemSettings: SystemSettings = {
    companyName: 'IPNEXT SA',
    timezone: 'America/Argentina/Buenos_Aires',
    currency: 'ARS',
    language: 'es',
    dateFormat: 'DD/MM/YYYY',
    invoicePrefix: 'FAC-',
    supportEmail: 'soporte@ipnext.com.ar',
    website: 'https://ipnext.com.ar',
  };

  private emailSettings: EmailSettings = {
    smtpHost: 'smtp.ipnext.com.ar',
    smtpPort: 587,
    smtpUser: 'noreply@ipnext.com.ar',
    smtpPassword: '••••••••',
    fromName: 'IPNEXT',
    fromEmail: 'noreply@ipnext.com.ar',
    useTls: true,
  };

  private templates: MessageTemplate[] = [
    {
      id: 'tpl-1',
      name: 'Bienvenida',
      type: 'welcome',
      subject: 'Bienvenido a {{empresa.nombre}}',
      body: 'Estimado {{cliente.nombre}},\n\nBienvenido a {{empresa.nombre}}. Su cuenta ({{cliente.email}}) ha sido creada exitosamente.\n\nSaludos,\nEl equipo de {{empresa.nombre}}',
      variables: [
        { key: 'cliente.nombre', description: 'Nombre completo del cliente', example: 'Juan Pérez' },
        { key: 'cliente.email', description: 'Email del cliente', example: 'juan@example.com' },
        { key: 'empresa.nombre', description: 'Nombre de la empresa', example: 'IPNEXT SA' },
      ],
      updatedAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 'tpl-2',
      name: 'Factura',
      type: 'invoice',
      subject: 'Factura {{factura.numero}} disponible',
      body: 'Estimado {{cliente.nombre}},\n\nLe informamos que su factura {{factura.numero}} por ${{factura.monto}} está disponible. Vence el {{factura.vencimiento}}.\n\nSaludos,\nIPNEXT',
      variables: [
        { key: 'cliente.nombre', description: 'Nombre completo del cliente', example: 'Juan Pérez' },
        { key: 'factura.numero', description: 'Número de factura', example: 'FAC-001234' },
        { key: 'factura.monto', description: 'Monto total de la factura', example: '6500.00' },
        { key: 'factura.vencimiento', description: 'Fecha de vencimiento', example: '15/05/2026' },
      ],
      updatedAt: '2024-02-01T00:00:00Z',
    },
    {
      id: 'tpl-3',
      name: 'Confirmación de pago',
      type: 'payment',
      subject: 'Pago recibido - Gracias',
      body: 'Estimado {{cliente.nombre}},\n\nHemos recibido su pago de ${{pago.monto}} el día {{pago.fecha}}.\n\nSaludos,\nIPNEXT',
      variables: [
        { key: 'cliente.nombre', description: 'Nombre completo del cliente', example: 'Juan Pérez' },
        { key: 'pago.monto', description: 'Monto del pago recibido', example: '6500.00' },
        { key: 'pago.fecha', description: 'Fecha en que se recibió el pago', example: '28/04/2026' },
      ],
      updatedAt: '2024-03-01T00:00:00Z',
    },
  ];

  private apiTokens: ApiToken[] = [
    {
      id: 'tok-1',
      name: 'Integración ERP',
      token: '••••••••a1b2',
      permissions: ['read:clients', 'write:invoices'],
      createdAt: '2024-01-15T00:00:00Z',
      lastUsed: '2026-04-28T06:00:00Z',
    },
    {
      id: 'tok-2',
      name: 'Monitor de tickets',
      token: '••••••••c3d4',
      permissions: ['read:tickets'],
      createdAt: '2024-06-01T00:00:00Z',
      lastUsed: null,
    },
  ];

  async getSystemSettings(): Promise<SystemSettings> {
    return { ...this.systemSettings };
  }

  async updateSystemSettings(data: Partial<SystemSettings>): Promise<SystemSettings> {
    this.systemSettings = { ...this.systemSettings, ...data };
    return { ...this.systemSettings };
  }

  async getEmailSettings(): Promise<EmailSettings> {
    return { ...this.emailSettings };
  }

  async updateEmailSettings(data: Partial<EmailSettings>): Promise<EmailSettings> {
    this.emailSettings = { ...this.emailSettings, ...data };
    return { ...this.emailSettings };
  }

  async getTemplates(): Promise<MessageTemplate[]> {
    return [...this.templates];
  }

  async getTemplate(id: string): Promise<MessageTemplate | null> {
    return this.templates.find(t => t.id === id) ?? null;
  }

  async updateTemplate(id: string, data: Partial<MessageTemplate>): Promise<MessageTemplate | null> {
    const index = this.templates.findIndex(t => t.id === id);
    if (index === -1) return null;
    this.templates[index] = {
      ...this.templates[index],
      ...data,
      updatedAt: new Date().toISOString(),
    };
    return { ...this.templates[index] };
  }

  async getApiTokens(): Promise<ApiToken[]> {
    return [...this.apiTokens];
  }

  async createApiToken(name: string, permissions: string[]): Promise<ApiToken> {
    const rawToken = Math.random().toString(36).slice(2, 10);
    const token: ApiToken = {
      id: `tok-${nextTokenId++}`,
      name,
      token: `••••••••${rawToken.slice(-4)}`,
      permissions,
      createdAt: new Date().toISOString(),
      lastUsed: null,
    };
    this.apiTokens.push(token);
    return { ...token };
  }

  async revokeApiToken(id: string): Promise<boolean> {
    const index = this.apiTokens.findIndex(t => t.id === id);
    if (index === -1) return false;
    this.apiTokens.splice(index, 1);
    return true;
  }

  private financeSettings: FinanceSettings = {
    invoiceDueDays: 10,
    taxName: 'IVA',
    taxRate: 21,
    taxIncluded: false,
    autoGenerateInvoices: true,
    invoiceDay: 1,
    paymentMethods: [],
    lateFeeEnabled: true,
    lateFeeAmount: 500,
    lateFeeDays: 5,
    reminderDays: [3, 7],
    currency: 'ARS',
    currencySymbol: '$',
  };

  private paymentMethods: PaymentMethod[] = [
    {
      id: '1',
      name: 'Transferencia bancaria',
      type: 'bank_transfer',
      enabled: true,
      config: { cbu: '0000003100012345678901', alias: 'ipnext.pago' },
    },
    {
      id: '2',
      name: 'Mercado Pago',
      type: 'mercadopago',
      enabled: true,
      config: { publicKey: 'APP_USR-...', accessToken: 'APP_USR-...' },
    },
    {
      id: '3',
      name: 'Efectivo',
      type: 'cash',
      enabled: true,
      config: {},
    },
  ];

  private nextPaymentMethodId = 4;

  async getFinanceSettings(): Promise<FinanceSettings> {
    return { ...this.financeSettings, paymentMethods: [...this.paymentMethods] };
  }

  async updateFinanceSettings(data: Partial<FinanceSettings>): Promise<FinanceSettings> {
    this.financeSettings = { ...this.financeSettings, ...data };
    return { ...this.financeSettings, paymentMethods: [...this.paymentMethods] };
  }

  async getPaymentMethods(): Promise<PaymentMethod[]> {
    return [...this.paymentMethods];
  }

  async createPaymentMethod(data: Omit<PaymentMethod, 'id'>): Promise<PaymentMethod> {
    const method: PaymentMethod = {
      id: String(this.nextPaymentMethodId++),
      ...data,
    };
    this.paymentMethods.push(method);
    return { ...method };
  }

  async updatePaymentMethod(id: string, data: Partial<PaymentMethod>): Promise<PaymentMethod | null> {
    const index = this.paymentMethods.findIndex(m => m.id === id);
    if (index === -1) return null;
    this.paymentMethods[index] = { ...this.paymentMethods[index], ...data };
    return { ...this.paymentMethods[index] };
  }

  async deletePaymentMethod(id: string): Promise<boolean> {
    const index = this.paymentMethods.findIndex(m => m.id === id);
    if (index === -1) return false;
    this.paymentMethods.splice(index, 1);
    return true;
  }

  private webhooks: Webhook[] = [
    {
      id: 'wh-1',
      name: 'ERP Integration',
      url: 'https://erp.ipnext.com.ar/webhooks/billing',
      events: ['invoice.created', 'invoice.paid', 'payment.received'] as WebhookEvent[],
      secret: '••••••••',
      status: 'active',
      lastTriggered: '2026-04-28T06:00:00Z',
      lastStatus: 'success',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'wh-2',
      name: 'CRM Sync',
      url: 'https://crm.example.com/hooks/ipnext',
      events: ['client.created', 'client.updated', 'client.deleted'] as WebhookEvent[],
      secret: '••••••••',
      status: 'active',
      lastTriggered: '2026-04-27T12:00:00Z',
      lastStatus: 'success',
      createdAt: '2026-02-01T00:00:00Z',
    },
    {
      id: 'wh-3',
      name: 'Monitoring',
      url: 'https://monitor.example.com/events',
      events: ['device.offline', 'device.recovered'] as WebhookEvent[],
      secret: '••••••••',
      status: 'inactive',
      lastTriggered: null,
      lastStatus: null,
      createdAt: '2026-03-01T00:00:00Z',
    },
  ];

  async getWebhooks(): Promise<Webhook[]> {
    return [...this.webhooks];
  }

  async createWebhook(data: Omit<Webhook, 'id' | 'createdAt' | 'lastTriggered' | 'lastStatus'>): Promise<Webhook> {
    const webhook: Webhook = {
      id: `wh-${nextWebhookId++}`,
      ...data,
      createdAt: new Date().toISOString(),
      lastTriggered: null,
      lastStatus: null,
    };
    this.webhooks.push(webhook);
    return { ...webhook };
  }

  async updateWebhook(id: string, data: Partial<Webhook>): Promise<Webhook | null> {
    const index = this.webhooks.findIndex(w => w.id === id);
    if (index === -1) return null;
    this.webhooks[index] = { ...this.webhooks[index], ...data };
    return { ...this.webhooks[index] };
  }

  async deleteWebhook(id: string): Promise<boolean> {
    const index = this.webhooks.findIndex(w => w.id === id);
    if (index === -1) return false;
    this.webhooks.splice(index, 1);
    return true;
  }

  async testWebhook(id: string): Promise<{ success: boolean }> {
    const webhook = this.webhooks.find(w => w.id === id);
    if (!webhook) return { success: false };
    const index = this.webhooks.findIndex(w => w.id === id);
    this.webhooks[index] = {
      ...this.webhooks[index],
      lastTriggered: new Date().toISOString(),
      lastStatus: 'success',
    };
    return { success: true };
  }

  private backups: BackupRecord[] = [
    {
      id: 'bk-1',
      filename: 'backup-2026-04-21-0300.tar.gz',
      size: 52428800,
      type: 'scheduled',
      status: 'completed',
      createdAt: '2026-04-21T03:00:00Z',
      downloadUrl: '/api/settings/backups/bk-1/download',
    },
    {
      id: 'bk-2',
      filename: 'backup-2026-04-14-0300.tar.gz',
      size: 51380224,
      type: 'scheduled',
      status: 'completed',
      createdAt: '2026-04-14T03:00:00Z',
      downloadUrl: '/api/settings/backups/bk-2/download',
    },
    {
      id: 'bk-3',
      filename: 'backup-2026-04-07-0300.tar.gz',
      size: 50331648,
      type: 'scheduled',
      status: 'completed',
      createdAt: '2026-04-07T03:00:00Z',
      downloadUrl: '/api/settings/backups/bk-3/download',
    },
    {
      id: 'bk-4',
      filename: 'backup-2026-03-31-0300.tar.gz',
      size: 49283072,
      type: 'scheduled',
      status: 'completed',
      createdAt: '2026-03-31T03:00:00Z',
      downloadUrl: '/api/settings/backups/bk-4/download',
    },
    {
      id: 'bk-5',
      filename: 'backup-2026-03-24-0300.tar.gz',
      size: 48234496,
      type: 'scheduled',
      status: 'completed',
      createdAt: '2026-03-24T03:00:00Z',
      downloadUrl: '/api/settings/backups/bk-5/download',
    },
  ];

  async getBackups(): Promise<BackupRecord[]> {
    return [...this.backups];
  }

  async createBackup(): Promise<BackupRecord> {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10);
    const id = `bk-${nextBackupId++}`;
    const backup: BackupRecord = {
      id,
      filename: `backup-${datePart}-manual.tar.gz`,
      size: 0,
      type: 'manual',
      status: 'in_progress',
      createdAt: now.toISOString(),
      downloadUrl: `/api/settings/backups/${id}/download`,
    };
    this.backups.unshift(backup);
    return { ...backup };
  }

  async deleteBackup(id: string): Promise<boolean> {
    const index = this.backups.findIndex(b => b.id === id);
    if (index === -1) return false;
    this.backups.splice(index, 1);
    return true;
  }

  private clientPortalSettings: ClientPortalSettings = {
    enabled: true,
    portalUrl: 'https://portal.ipnext.com.ar',
    allowSelfRegistration: false,
    requireEmailVerification: true,
    allowPaymentOnline: true,
    allowTicketCreation: true,
    allowServiceManagement: false,
    welcomeMessage: 'Bienvenido al portal de clientes de IPNEXT',
    logoUrl: null,
    primaryColor: '#2563eb',
    customCss: '',
  };

  async getClientPortalSettings(): Promise<ClientPortalSettings> {
    return { ...this.clientPortalSettings };
  }

  async updateClientPortalSettings(data: Partial<ClientPortalSettings>): Promise<ClientPortalSettings> {
    this.clientPortalSettings = { ...this.clientPortalSettings, ...data };
    return { ...this.clientPortalSettings };
  }
}
