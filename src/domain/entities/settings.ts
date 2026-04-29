export interface SystemSettings {
  companyName: string;
  timezone: string;
  currency: string;
  language: string;
  dateFormat: string;
  invoicePrefix: string;
  supportEmail: string;
  website: string;
}

export interface EmailSettings {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  fromName: string;
  fromEmail: string;
  useTls: boolean;
}

export interface TemplateVariable {
  key: string;        // e.g. "cliente.nombre"
  description: string;
  example: string;
}

export interface MessageTemplate {
  id: string;
  name: string;
  type: 'invoice' | 'payment' | 'welcome' | 'overdue' | 'custom';
  subject: string;
  body: string;       // supports {{variable}} syntax
  variables?: TemplateVariable[];
  updatedAt: string;
}

export interface ApiToken {
  id: string;
  name: string;
  token: string;
  permissions: string[];
  createdAt: string;
  lastUsed: string | null;
}

export interface PaymentMethod {
  id: string;
  name: string;
  type: 'bank_transfer' | 'mercadopago' | 'cash' | 'card' | 'other';
  enabled: boolean;
  config: Record<string, string>;
}

export interface FinanceSettings {
  invoiceDueDays: number;
  taxName: string;
  taxRate: number;
  taxIncluded: boolean;
  autoGenerateInvoices: boolean;
  invoiceDay: number;
  paymentMethods: PaymentMethod[];
  lateFeeEnabled: boolean;
  lateFeeAmount: number;
  lateFeeDays: number;
  reminderDays: number[];
  currency: string;
  currencySymbol: string;
}

export type WebhookEvent =
  | 'client.created' | 'client.updated' | 'client.deleted'
  | 'invoice.created' | 'invoice.paid' | 'payment.received'
  | 'ticket.created' | 'ticket.resolved'
  | 'device.offline' | 'device.recovered';

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  secret: string;
  status: 'active' | 'inactive';
  lastTriggered: string | null;
  lastStatus: 'success' | 'failed' | null;
  createdAt: string;
}

export interface BackupRecord {
  id: string;
  filename: string;
  size: number;
  type: 'manual' | 'scheduled';
  status: 'completed' | 'in_progress' | 'failed';
  createdAt: string;
  downloadUrl: string;
}

export interface ClientPortalSettings {
  enabled: boolean;
  portalUrl: string;
  allowSelfRegistration: boolean;
  requireEmailVerification: boolean;
  allowPaymentOnline: boolean;
  allowTicketCreation: boolean;
  allowServiceManagement: boolean;
  welcomeMessage: string;
  logoUrl: string | null;
  primaryColor: string;
  customCss: string;
}
