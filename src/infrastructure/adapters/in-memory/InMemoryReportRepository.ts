import { ReportType, ReportResult, ReportDefinition, ReportCategory } from '@domain/entities/report';

export const REPORT_DEFINITIONS: ReportDefinition[] = [
  // Clients
  {
    id: 'rpt-clients-by-status',
    type: 'clients_by_status',
    category: 'clients',
    name: 'Clientes por estado',
    description: 'Distribución de clientes según su estado actual en el sistema.',
    filters: [
      { key: 'date', label: 'Fecha', type: 'date', required: false },
    ],
  },
  {
    id: 'rpt-clients-by-plan',
    type: 'clients_by_plan',
    category: 'clients',
    name: 'Clientes por plan',
    description: 'Cantidad de suscriptores y facturación agrupada por plan de servicio.',
    filters: [
      { key: 'date', label: 'Fecha', type: 'date', required: false },
    ],
  },
  {
    id: 'rpt-clients-by-location',
    type: 'clients_by_location',
    category: 'clients',
    name: 'Clientes por ubicación',
    description: 'Distribución geográfica de clientes por localidad.',
    filters: [],
  },
  {
    id: 'rpt-new-clients',
    type: 'new_clients',
    category: 'clients',
    name: 'Nuevos clientes',
    description: 'Cantidad de nuevos clientes registrados por día en el período seleccionado.',
    filters: [
      { key: 'dateFrom', label: 'Desde', type: 'date', required: true },
      { key: 'dateTo', label: 'Hasta', type: 'date', required: true },
    ],
  },
  {
    id: 'rpt-churned-clients',
    type: 'churned_clients',
    category: 'clients',
    name: 'Clientes dados de baja',
    description: 'Clientes que cancelaron el servicio en el período, con motivo de baja.',
    filters: [
      { key: 'dateFrom', label: 'Desde', type: 'date', required: true },
      { key: 'dateTo', label: 'Hasta', type: 'date', required: true },
    ],
  },
  // Finance
  {
    id: 'rpt-revenue-by-period',
    type: 'revenue_by_period',
    category: 'finance',
    name: 'Ingresos por período',
    description: 'Resumen de facturación, pagos y saldo pendiente por período.',
    filters: [
      { key: 'period', label: 'Período', type: 'select', required: true, options: [
        { value: 'monthly', label: 'Mensual' },
        { value: 'quarterly', label: 'Trimestral' },
        { value: 'yearly', label: 'Anual' },
      ]},
    ],
  },
  {
    id: 'rpt-unpaid-invoices',
    type: 'unpaid_invoices',
    category: 'finance',
    name: 'Facturas impagas',
    description: 'Listado de facturas pendientes de pago con días de vencimiento.',
    filters: [
      { key: 'minDays', label: 'Días mínimos vencidos', type: 'text', required: false },
    ],
  },
  {
    id: 'rpt-payment-methods',
    type: 'payment_methods',
    category: 'finance',
    name: 'Métodos de pago',
    description: 'Distribución de pagos recibidos por método de pago.',
    filters: [
      { key: 'dateFrom', label: 'Desde', type: 'date', required: false },
      { key: 'dateTo', label: 'Hasta', type: 'date', required: false },
    ],
  },
  {
    id: 'rpt-overdue-clients',
    type: 'overdue_clients',
    category: 'finance',
    name: 'Clientes morosos',
    description: 'Clientes con facturas vencidas y monto total adeudado.',
    filters: [],
  },
  {
    id: 'rpt-tax-report',
    type: 'tax_report',
    category: 'finance',
    name: 'Informe fiscal',
    description: 'Resumen de impuestos facturados por período.',
    filters: [
      { key: 'year', label: 'Año', type: 'text', required: true },
    ],
  },
  // Network
  {
    id: 'rpt-device-uptime',
    type: 'device_uptime',
    category: 'network',
    name: 'Disponibilidad de dispositivos',
    description: 'Porcentaje de uptime y horas de caída por dispositivo de red.',
    filters: [
      { key: 'dateFrom', label: 'Desde', type: 'date', required: false },
      { key: 'dateTo', label: 'Hasta', type: 'date', required: false },
    ],
  },
  {
    id: 'rpt-bandwidth-usage',
    type: 'bandwidth_usage',
    category: 'network',
    name: 'Uso de ancho de banda',
    description: 'Tráfico de descarga y subida en GB por dispositivo y período.',
    filters: [
      { key: 'period', label: 'Período', type: 'select', required: false, options: [
        { value: 'today', label: 'Hoy' },
        { value: 'week', label: 'Semana' },
        { value: 'month', label: 'Mes' },
      ]},
    ],
  },
  {
    id: 'rpt-ip-usage',
    type: 'ip_usage',
    category: 'network',
    name: 'Uso de IPs',
    description: 'Porcentaje de uso de cada pool de IPs configurado.',
    filters: [],
  },
  {
    id: 'rpt-nas-sessions',
    type: 'nas_sessions',
    category: 'network',
    name: 'Sesiones NAS',
    description: 'Sesiones activas y duración promedio por servidor NAS.',
    filters: [],
  },
  // Scheduling
  {
    id: 'rpt-tasks-by-status',
    type: 'tasks_by_status',
    category: 'scheduling',
    name: 'Tareas por estado',
    description: 'Distribución de tareas técnicas por estado y tiempo promedio de resolución.',
    filters: [
      { key: 'dateFrom', label: 'Desde', type: 'date', required: false },
      { key: 'dateTo', label: 'Hasta', type: 'date', required: false },
    ],
  },
  {
    id: 'rpt-technician-performance',
    type: 'technician_performance',
    category: 'scheduling',
    name: 'Rendimiento de técnicos',
    description: 'Tareas completadas y calificación promedio por técnico.',
    filters: [
      { key: 'dateFrom', label: 'Desde', type: 'date', required: false },
      { key: 'dateTo', label: 'Hasta', type: 'date', required: false },
    ],
  },
  // Voice
  {
    id: 'rpt-cdr-summary',
    type: 'cdr_summary',
    category: 'voice',
    name: 'Resumen CDR',
    description: 'Resumen de registros de llamadas agrupados por categoría.',
    filters: [
      { key: 'dateFrom', label: 'Desde', type: 'date', required: false },
      { key: 'dateTo', label: 'Hasta', type: 'date', required: false },
    ],
  },
  {
    id: 'rpt-voice-revenue',
    type: 'voice_revenue',
    category: 'voice',
    name: 'Ingresos por voz',
    description: 'Ingresos generados por servicios de voz por período.',
    filters: [
      { key: 'dateFrom', label: 'Desde', type: 'date', required: false },
      { key: 'dateTo', label: 'Hasta', type: 'date', required: false },
    ],
  },
  // Inventory
  {
    id: 'rpt-stock-levels',
    type: 'stock_levels',
    category: 'inventory',
    name: 'Niveles de stock',
    description: 'Estado del inventario con cantidad actual y stock mínimo.',
    filters: [],
  },
  {
    id: 'rpt-low-stock',
    type: 'low_stock',
    category: 'inventory',
    name: 'Stock bajo',
    description: 'Productos con cantidad por debajo del stock mínimo configurado.',
    filters: [],
  },
];

function generateRows(type: ReportType, _filters: Record<string, string>): {
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
  summary: Record<string, unknown>;
} {
  switch (type) {
    case 'clients_by_status':
      return {
        columns: [
          { key: 'status', label: 'Estado' },
          { key: 'count', label: 'Cantidad' },
          { key: 'percentage', label: 'Porcentaje' },
        ],
        rows: [
          { id: '1', status: 'Activo', count: 1843, percentage: '84.2%' },
          { id: '2', status: 'Bloqueado', count: 127, percentage: '5.8%' },
          { id: '3', status: 'Inactivo', count: 234, percentage: '10.0%' },
        ],
        summary: { total: 2204 },
      };

    case 'clients_by_plan':
      return {
        columns: [
          { key: 'planName', label: 'Plan' },
          { key: 'subscriberCount', label: 'Suscriptores' },
          { key: 'revenue', label: 'Ingresos ($)' },
        ],
        rows: [
          { id: '1', planName: 'Fibra 100 Mbps', subscriberCount: 842, revenue: 168400 },
          { id: '2', planName: 'Fibra 200 Mbps', subscriberCount: 521, revenue: 156300 },
          { id: '3', planName: 'Fibra 500 Mbps', subscriberCount: 280, revenue: 140000 },
          { id: '4', planName: 'ADSL 20 Mbps', subscriberCount: 134, revenue: 20100 },
          { id: '5', planName: 'Empresarial 1 Gbps', subscriberCount: 66, revenue: 99000 },
        ],
        summary: { totalSubscribers: 1843, totalRevenue: 583800 },
      };

    case 'clients_by_location':
      return {
        columns: [
          { key: 'locationName', label: 'Localidad' },
          { key: 'clientCount', label: 'Clientes' },
        ],
        rows: [
          { id: '1', locationName: 'Capital', clientCount: 743 },
          { id: '2', locationName: 'Villa Urquiza', clientCount: 412 },
          { id: '3', locationName: 'Palermo', clientCount: 387 },
          { id: '4', locationName: 'San Telmo', clientCount: 201 },
          { id: '5', locationName: 'Mataderos', clientCount: 100 },
        ],
        summary: { total: 1843 },
      };

    case 'new_clients': {
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date('2026-03-29');
        d.setDate(d.getDate() + i);
        rows.push({
          id: String(i + 1),
          date: d.toISOString().split('T')[0],
          count: Math.floor(Math.random() * 6) + 5,
        });
      }
      return {
        columns: [
          { key: 'date', label: 'Fecha' },
          { key: 'count', label: 'Nuevos clientes' },
        ],
        rows,
        summary: { totalNewClients: rows.reduce((s, r) => s + (r['count'] as number), 0) },
      };
    }

    case 'churned_clients':
      return {
        columns: [
          { key: 'date', label: 'Fecha' },
          { key: 'count', label: 'Bajas' },
          { key: 'reason', label: 'Motivo principal' },
        ],
        rows: [
          { id: '1', date: '2026-04-01', count: 3, reason: 'Mudanza' },
          { id: '2', date: '2026-04-05', count: 2, reason: 'Precio' },
          { id: '3', date: '2026-04-10', count: 5, reason: 'Competencia' },
          { id: '4', date: '2026-04-15', count: 1, reason: 'Sin motivo' },
          { id: '5', date: '2026-04-20', count: 4, reason: 'Calidad' },
        ],
        summary: { totalChurned: 15 },
      };

    case 'revenue_by_period':
      return {
        columns: [
          { key: 'period', label: 'Período' },
          { key: 'invoiced', label: 'Facturado ($)' },
          { key: 'paid', label: 'Cobrado ($)' },
          { key: 'pending', label: 'Pendiente ($)' },
        ],
        rows: [
          { id: '1', period: 'Enero 2026', invoiced: 583800, paid: 541200, pending: 42600 },
          { id: '2', period: 'Febrero 2026', invoiced: 591200, paid: 560800, pending: 30400 },
          { id: '3', period: 'Marzo 2026', invoiced: 578400, paid: 534900, pending: 43500 },
          { id: '4', period: 'Abril 2026', invoiced: 602100, paid: 489700, pending: 112400 },
        ],
        summary: { totalInvoiced: 2355500, totalPaid: 2126600, totalPending: 228900 },
      };

    case 'unpaid_invoices':
      return {
        columns: [
          { key: 'clientId', label: 'ID Cliente' },
          { key: 'clientName', label: 'Cliente' },
          { key: 'amount', label: 'Monto ($)' },
          { key: 'dueDate', label: 'Vencimiento' },
          { key: 'daysPastDue', label: 'Días vencidos' },
        ],
        rows: [
          { id: '1', clientId: 'CLI-0012', clientName: 'Juan García', amount: 1200, dueDate: '2026-03-15', daysPastDue: 44 },
          { id: '2', clientId: 'CLI-0087', clientName: 'María López', amount: 2400, dueDate: '2026-03-20', daysPastDue: 39 },
          { id: '3', clientId: 'CLI-0234', clientName: 'Carlos Ruiz', amount: 800, dueDate: '2026-04-01', daysPastDue: 27 },
          { id: '4', clientId: 'CLI-0341', clientName: 'Ana Martínez', amount: 3600, dueDate: '2026-04-10', daysPastDue: 18 },
          { id: '5', clientId: 'CLI-0512', clientName: 'Pedro Sánchez', amount: 1600, dueDate: '2026-04-15', daysPastDue: 13 },
          { id: '6', clientId: 'CLI-0678', clientName: 'Laura Gómez', amount: 2000, dueDate: '2026-04-20', daysPastDue: 8 },
        ],
        summary: { totalUnpaid: 11600, count: 6 },
      };

    case 'payment_methods':
      return {
        columns: [
          { key: 'method', label: 'Método' },
          { key: 'amount', label: 'Monto ($)' },
          { key: 'count', label: 'Transacciones' },
          { key: 'percentage', label: 'Porcentaje' },
        ],
        rows: [
          { id: '1', method: 'Transferencia bancaria', amount: 289400, count: 412, percentage: '54.2%' },
          { id: '2', method: 'Tarjeta de crédito', amount: 142800, count: 203, percentage: '26.7%' },
          { id: '3', method: 'Efectivo', amount: 68200, count: 98, percentage: '12.8%' },
          { id: '4', method: 'Débito automático', amount: 33900, count: 48, percentage: '6.3%' },
        ],
        summary: { totalAmount: 534300, totalTransactions: 761 },
      };

    case 'overdue_clients':
      return {
        columns: [
          { key: 'clientName', label: 'Cliente' },
          { key: 'totalOwed', label: 'Total adeudado ($)' },
          { key: 'oldestInvoiceDays', label: 'Días sin pagar' },
        ],
        rows: [
          { id: '1', clientName: 'Juan García', totalOwed: 3600, oldestInvoiceDays: 90 },
          { id: '2', clientName: 'María López', totalOwed: 2400, oldestInvoiceDays: 60 },
          { id: '3', clientName: 'Carlos Ruiz', totalOwed: 1200, oldestInvoiceDays: 45 },
          { id: '4', clientName: 'Ana Martínez', totalOwed: 4800, oldestInvoiceDays: 120 },
          { id: '5', clientName: 'Pedro Sánchez', totalOwed: 800, oldestInvoiceDays: 30 },
        ],
        summary: { totalOverdue: 12800, count: 5 },
      };

    case 'tax_report':
      return {
        columns: [
          { key: 'period', label: 'Período' },
          { key: 'taxableAmount', label: 'Base imponible ($)' },
          { key: 'taxAmount', label: 'Impuesto ($)' },
          { key: 'taxRate', label: 'Tasa' },
        ],
        rows: [
          { id: '1', period: 'Enero 2026', taxableAmount: 480000, taxAmount: 100800, taxRate: '21%' },
          { id: '2', period: 'Febrero 2026', taxableAmount: 487000, taxAmount: 102270, taxRate: '21%' },
          { id: '3', period: 'Marzo 2026', taxableAmount: 476000, taxAmount: 99960, taxRate: '21%' },
          { id: '4', period: 'Abril 2026', taxableAmount: 496000, taxAmount: 104160, taxRate: '21%' },
        ],
        summary: { totalTaxable: 1939000, totalTax: 407190 },
      };

    case 'device_uptime':
      return {
        columns: [
          { key: 'deviceName', label: 'Dispositivo' },
          { key: 'uptimePercent', label: 'Uptime (%)' },
          { key: 'downtimeHours', label: 'Horas caídas' },
        ],
        rows: [
          { id: '1', deviceName: 'Router Core CABA', uptimePercent: 99.9, downtimeHours: 0.7 },
          { id: '2', deviceName: 'Switch Distribución Norte', uptimePercent: 98.5, downtimeHours: 10.9 },
          { id: '3', deviceName: 'OLT Fibra Sur', uptimePercent: 99.5, downtimeHours: 3.6 },
          { id: '4', deviceName: 'NAS Radius Principal', uptimePercent: 100.0, downtimeHours: 0 },
          { id: '5', deviceName: 'Switch Acc Palermo', uptimePercent: 97.2, downtimeHours: 20.2 },
        ],
        summary: { avgUptime: 99.02 },
      };

    case 'bandwidth_usage':
      return {
        columns: [
          { key: 'deviceName', label: 'Dispositivo' },
          { key: 'downloadGB', label: 'Descarga (GB)' },
          { key: 'uploadGB', label: 'Subida (GB)' },
          { key: 'period', label: 'Período' },
        ],
        rows: [
          { id: '1', deviceName: 'Router Core CABA', downloadGB: 48200, uploadGB: 18400, period: 'Abril 2026' },
          { id: '2', deviceName: 'Switch Distribución Norte', downloadGB: 12400, uploadGB: 4800, period: 'Abril 2026' },
          { id: '3', deviceName: 'OLT Fibra Sur', downloadGB: 22800, uploadGB: 8900, period: 'Abril 2026' },
          { id: '4', deviceName: 'Switch Acc Palermo', downloadGB: 9600, uploadGB: 3200, period: 'Abril 2026' },
        ],
        summary: { totalDownloadGB: 93000, totalUploadGB: 35300 },
      };

    case 'ip_usage':
      return {
        columns: [
          { key: 'network', label: 'Red' },
          { key: 'usedIps', label: 'IPs usadas' },
          { key: 'totalIps', label: 'IPs totales' },
          { key: 'usagePercent', label: 'Uso (%)' },
        ],
        rows: [
          { id: '1', network: '192.168.1.0/24', usedIps: 210, totalIps: 254, usagePercent: 82.7 },
          { id: '2', network: '10.0.0.0/22', usedIps: 876, totalIps: 1022, usagePercent: 85.7 },
          { id: '3', network: '172.16.0.0/20', usedIps: 2341, totalIps: 4094, usagePercent: 57.2 },
          { id: '4', network: '192.168.100.0/24', usedIps: 45, totalIps: 254, usagePercent: 17.7 },
          { id: '5', network: '10.10.0.0/16', usedIps: 1234, totalIps: 65534, usagePercent: 1.9 },
        ],
        summary: { totalUsed: 4706, totalAvailable: 71158 },
      };

    case 'nas_sessions':
      return {
        columns: [
          { key: 'nasName', label: 'Servidor NAS' },
          { key: 'activeSessions', label: 'Sesiones activas' },
          { key: 'avgDuration', label: 'Duración promedio (h)' },
        ],
        rows: [
          { id: '1', nasName: 'NAS-RADIUS-01', activeSessions: 1247, avgDuration: 6.4 },
          { id: '2', nasName: 'NAS-RADIUS-02', activeSessions: 834, avgDuration: 5.9 },
          { id: '3', nasName: 'NAS-BRAS-01', activeSessions: 312, avgDuration: 8.1 },
        ],
        summary: { totalActiveSessions: 2393 },
      };

    case 'tasks_by_status':
      return {
        columns: [
          { key: 'status', label: 'Estado' },
          { key: 'count', label: 'Tareas' },
          { key: 'avgCompletionHours', label: 'Horas promedio' },
        ],
        rows: [
          { id: '1', status: 'Pendiente', count: 48, avgCompletionHours: null },
          { id: '2', status: 'En progreso', count: 23, avgCompletionHours: null },
          { id: '3', status: 'Completada', count: 187, avgCompletionHours: 3.2 },
          { id: '4', status: 'Cancelada', count: 12, avgCompletionHours: null },
        ],
        summary: { total: 270, completionRate: '69.3%' },
      };

    case 'technician_performance':
      return {
        columns: [
          { key: 'technicianName', label: 'Técnico' },
          { key: 'completedTasks', label: 'Tareas completadas' },
          { key: 'avgRating', label: 'Calificación promedio' },
        ],
        rows: [
          { id: '1', technicianName: 'Carlos Técnico', completedTasks: 78, avgRating: 4.8 },
          { id: '2', technicianName: 'María Técnica', completedTasks: 65, avgRating: 4.9 },
          { id: '3', technicianName: 'Pedro Técnico', completedTasks: 44, avgRating: 4.5 },
        ],
        summary: { totalCompleted: 187, avgRating: 4.73 },
      };

    case 'cdr_summary':
      return {
        columns: [
          { key: 'category', label: 'Categoría' },
          { key: 'totalCalls', label: 'Llamadas' },
          { key: 'totalMinutes', label: 'Minutos' },
          { key: 'revenue', label: 'Ingresos ($)' },
        ],
        rows: [
          { id: '1', category: 'Local', totalCalls: 12840, totalMinutes: 48200, revenue: 9640 },
          { id: '2', category: 'Nacional', totalCalls: 4210, totalMinutes: 18900, revenue: 5670 },
          { id: '3', category: 'Internacional', totalCalls: 380, totalMinutes: 2100, revenue: 4200 },
          { id: '4', category: 'Celular', totalCalls: 7640, totalMinutes: 28400, revenue: 14200 },
        ],
        summary: { totalCalls: 25070, totalMinutes: 97600, totalRevenue: 33710 },
      };

    case 'voice_revenue':
      return {
        columns: [
          { key: 'period', label: 'Período' },
          { key: 'calls', label: 'Llamadas' },
          { key: 'minutes', label: 'Minutos' },
          { key: 'revenue', label: 'Ingresos ($)' },
        ],
        rows: [
          { id: '1', period: 'Enero 2026', calls: 24100, minutes: 93400, revenue: 31800 },
          { id: '2', period: 'Febrero 2026', calls: 22800, minutes: 89100, revenue: 30200 },
          { id: '3', period: 'Marzo 2026', calls: 25400, minutes: 98700, revenue: 33500 },
          { id: '4', period: 'Abril 2026', calls: 25070, minutes: 97600, revenue: 33710 },
        ],
        summary: { totalRevenue: 129210 },
      };

    case 'stock_levels':
      return {
        columns: [
          { key: 'productName', label: 'Producto' },
          { key: 'quantity', label: 'Cantidad' },
          { key: 'minStock', label: 'Stock mínimo' },
          { key: 'status', label: 'Estado' },
        ],
        rows: [
          { id: '1', productName: 'ONT Fibra GPON', quantity: 45, minStock: 20, status: 'OK' },
          { id: '2', productName: 'Cable UTP Cat6 (rollo 100m)', quantity: 8, minStock: 10, status: 'Bajo' },
          { id: '3', productName: 'Switch 24 puertos PoE', quantity: 12, minStock: 5, status: 'OK' },
          { id: '4', productName: 'Router Mikrotik hAP', quantity: 3, minStock: 8, status: 'Bajo' },
          { id: '5', productName: 'Conector RJ45 (bolsa 100u)', quantity: 62, minStock: 30, status: 'OK' },
          { id: '6', productName: 'Splitter PLC 1:8', quantity: 4, minStock: 15, status: 'Bajo' },
          { id: '7', productName: 'Patch panel 24p', quantity: 18, minStock: 5, status: 'OK' },
        ],
        summary: { total: 7, lowStock: 3, ok: 4 },
      };

    case 'low_stock':
      return {
        columns: [
          { key: 'productName', label: 'Producto' },
          { key: 'quantity', label: 'Cantidad actual' },
          { key: 'minStock', label: 'Stock mínimo' },
          { key: 'supplier', label: 'Proveedor' },
        ],
        rows: [
          { id: '1', productName: 'Cable UTP Cat6 (rollo 100m)', quantity: 8, minStock: 10, supplier: 'Cablería SA' },
          { id: '2', productName: 'Router Mikrotik hAP', quantity: 3, minStock: 8, supplier: 'Redes & Co' },
          { id: '3', productName: 'Splitter PLC 1:8', quantity: 4, minStock: 15, supplier: 'FiberTech' },
        ],
        summary: { count: 3 },
      };

    default:
      return { columns: [], rows: [], summary: {} };
  }
}

export class InMemoryReportRepository {
  getDefinitions(): ReportDefinition[] {
    return REPORT_DEFINITIONS;
  }

  generateReport(type: ReportType, filters: Record<string, string>): ReportResult {
    const { columns, rows, summary } = generateRows(type, filters);
    return {
      reportType: type,
      generatedAt: new Date().toISOString(),
      filters,
      columns,
      rows,
      summary,
    };
  }
}
