import { VoipCategory, VoipCdr, VoipPlan } from '../entities/voz';

export interface VozRepository {
  listVoipCategories(): Promise<VoipCategory[]>;
  createVoipCategory(data: Omit<VoipCategory, 'id'>): Promise<VoipCategory>;
  listVoipCdrs(): Promise<VoipCdr[]>;
  listVoipPlans(): Promise<VoipPlan[]>;
  createVoipPlan(data: Omit<VoipPlan, 'id'>): Promise<VoipPlan>;
}
