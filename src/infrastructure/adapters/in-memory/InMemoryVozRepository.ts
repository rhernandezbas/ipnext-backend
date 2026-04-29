import { VoipCategory, VoipCdr, VoipPlan } from '@domain/entities/voz';
import { VozRepository } from '@domain/ports/VozRepository';

let nextCategoryId = 5;
let nextPlanId = 3;

export class InMemoryVozRepository implements VozRepository {
  private categories: VoipCategory[] = [
    {
      id: '1',
      name: 'Llamadas locales',
      prefix: '011',
      pricePerMinute: 0.5,
      freeMinutes: 300,
      status: 'active',
    },
    {
      id: '2',
      name: 'Larga distancia',
      prefix: '0',
      pricePerMinute: 1.5,
      freeMinutes: 100,
      status: 'active',
    },
    {
      id: '3',
      name: 'Celulares',
      prefix: '15',
      pricePerMinute: 2.0,
      freeMinutes: 60,
      status: 'active',
    },
    {
      id: '4',
      name: 'Internacional',
      prefix: '00',
      pricePerMinute: 8.0,
      freeMinutes: 0,
      status: 'inactive',
    },
  ];

  private cdrs: VoipCdr[] = [
    { id: '1', clientId: 'cli-001', clientName: 'Juan García', callerNumber: '01145678901', calledNumber: '01145670001', duration: 180, categoryId: '1', categoryName: 'Llamadas locales', cost: 1.5, status: 'answered', startedAt: '2026-04-28T09:00:00Z' },
    { id: '2', clientId: 'cli-002', clientName: 'Roberto López', callerNumber: '01145678902', calledNumber: '03514567890', duration: 240, categoryId: '2', categoryName: 'Larga distancia', cost: 6.0, status: 'answered', startedAt: '2026-04-28T09:30:00Z' },
    { id: '3', clientId: 'cli-001', clientName: 'Juan García', callerNumber: '01145678901', calledNumber: '1567890001', duration: 0, categoryId: '3', categoryName: 'Celulares', cost: 0, status: 'missed', startedAt: '2026-04-28T10:00:00Z' },
    { id: '4', clientId: 'cli-003', clientName: 'Ana Martínez', callerNumber: '01145678903', calledNumber: '01145670002', duration: 90, categoryId: '1', categoryName: 'Llamadas locales', cost: 0.75, status: 'answered', startedAt: '2026-04-28T10:15:00Z' },
    { id: '5', clientId: 'cli-004', clientName: 'Pedro Torres', callerNumber: '01145678904', calledNumber: '01145670003', duration: 0, categoryId: '1', categoryName: 'Llamadas locales', cost: 0, status: 'busy', startedAt: '2026-04-28T10:45:00Z' },
    { id: '6', clientId: 'cli-002', clientName: 'Roberto López', callerNumber: '01145678902', calledNumber: '0080012345', duration: 360, categoryId: '4', categoryName: 'Internacional', cost: 48.0, status: 'answered', startedAt: '2026-04-28T11:00:00Z' },
    { id: '7', clientId: 'cli-005', clientName: 'María Fernández', callerNumber: '01145678905', calledNumber: '01145670004', duration: 120, categoryId: '1', categoryName: 'Llamadas locales', cost: 1.0, status: 'answered', startedAt: '2026-04-28T11:30:00Z' },
    { id: '8', clientId: 'cli-003', clientName: 'Ana Martínez', callerNumber: '01145678903', calledNumber: '1567890002', duration: 300, categoryId: '3', categoryName: 'Celulares', cost: 10.0, status: 'answered', startedAt: '2026-04-28T12:00:00Z' },
    { id: '9', clientId: 'cli-001', clientName: 'Juan García', callerNumber: '01145678901', calledNumber: '02215678901', duration: 0, categoryId: '2', categoryName: 'Larga distancia', cost: 0, status: 'failed', startedAt: '2026-04-28T13:00:00Z' },
    { id: '10', clientId: 'cli-004', clientName: 'Pedro Torres', callerNumber: '01145678904', calledNumber: '01145670005', duration: 450, categoryId: '1', categoryName: 'Llamadas locales', cost: 3.75, status: 'answered', startedAt: '2026-04-28T14:00:00Z' },
  ];

  private plans: VoipPlan[] = [
    {
      id: '1',
      name: 'Plan VoIP Básico',
      monthlyPrice: 1500,
      includedMinutes: 300,
      categories: ['1', '3'],
      status: 'active',
    },
    {
      id: '2',
      name: 'Plan VoIP Total',
      monthlyPrice: 3500,
      includedMinutes: 1000,
      categories: ['1', '2', '3', '4'],
      status: 'active',
    },
  ];

  async listVoipCategories(): Promise<VoipCategory[]> {
    return [...this.categories];
  }

  async createVoipCategory(data: Omit<VoipCategory, 'id'>): Promise<VoipCategory> {
    const category: VoipCategory = {
      id: String(nextCategoryId++),
      ...data,
    };
    this.categories.push(category);
    return { ...category };
  }

  async listVoipCdrs(): Promise<VoipCdr[]> {
    return [...this.cdrs];
  }

  async listVoipPlans(): Promise<VoipPlan[]> {
    return [...this.plans];
  }

  async createVoipPlan(data: Omit<VoipPlan, 'id'>): Promise<VoipPlan> {
    const plan: VoipPlan = {
      id: String(nextPlanId++),
      ...data,
    };
    this.plans.push(plan);
    return { ...plan };
  }
}
