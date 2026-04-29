export type ReportCategory = 'clients' | 'finance' | 'network' | 'scheduling' | 'voice' | 'inventory';

export type ReportType =
  // Clients
  | 'clients_by_status' | 'clients_by_plan' | 'clients_by_location' | 'new_clients' | 'churned_clients'
  // Finance
  | 'revenue_by_period' | 'unpaid_invoices' | 'payment_methods' | 'overdue_clients' | 'tax_report'
  // Network
  | 'device_uptime' | 'bandwidth_usage' | 'ip_usage' | 'nas_sessions'
  // Scheduling
  | 'tasks_by_status' | 'technician_performance'
  // Voice
  | 'cdr_summary' | 'voice_revenue'
  // Inventory
  | 'stock_levels' | 'low_stock';

export interface ReportDefinition {
  id: string;
  type: ReportType;
  category: ReportCategory;
  name: string;
  description: string;
  filters: ReportFilter[];
}

export interface ReportFilter {
  key: string;
  label: string;
  type: 'date' | 'select' | 'text' | 'daterange';
  options?: { value: string; label: string }[];
  required: boolean;
}

export interface ReportResult {
  reportType: ReportType;
  generatedAt: string;
  filters: Record<string, string>;
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  summary: Record<string, unknown>;
}
