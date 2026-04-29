export type NotificationType =
  | 'device_offline' | 'device_recovered' | 'new_ticket' | 'ticket_resolved'
  | 'payment_received' | 'invoice_overdue' | 'low_stock' | 'new_lead'
  | 'backup_completed' | 'system_update';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'success';
  read: boolean;
  link: string | null;      // frontend URL to navigate to
  createdAt: string;
  readAt: string | null;
}
