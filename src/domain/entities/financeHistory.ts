export type FinanceEventType =
  | 'invoice_created'
  | 'invoice_paid'
  | 'payment_received'
  | 'credit_note_applied'
  | 'refund'
  | 'late_fee'
  | 'plan_changed'
  | 'service_activated'
  | 'service_deactivated';

export interface FinanceHistoryEvent {
  id: string;
  type: FinanceEventType;
  description: string;
  clientId: string;
  clientName: string;
  amount: number | null;
  referenceId: string | null;
  adminId: string;
  adminName: string;
  occurredAt: string;
}
