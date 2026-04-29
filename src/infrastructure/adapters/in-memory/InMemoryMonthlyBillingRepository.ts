import { MonthlyBillingRepository } from '@domain/ports/MonthlyBillingRepository';
import { MonthlyBillingResponse, MonthlyBillingData } from '@domain/entities/billing';

const MONTH_NAMES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function buildMonthData(year: number, month: number, invoiced: number, paid: number): MonthlyBillingData {
  const paddedMonth = String(month + 1).padStart(2, '0');
  return {
    period: `${year}-${paddedMonth}`,
    label: `${MONTH_NAMES_ES[month]} ${year}`,
    invoiced,
    paid,
  };
}

export class InMemoryMonthlyBillingRepository implements MonthlyBillingRepository {
  async getMonthly(): Promise<MonthlyBillingResponse> {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed

    const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
    const nextMonthDate = new Date(currentYear, currentMonth + 1, 1);

    return {
      lastMonth: buildMonthData(lastMonthDate.getFullYear(), lastMonthDate.getMonth(), 48500, 45200),
      currentMonth: buildMonthData(currentYear, currentMonth, 52300, 38100),
      nextMonth: buildMonthData(nextMonthDate.getFullYear(), nextMonthDate.getMonth(), 0, 0),
    };
  }
}
