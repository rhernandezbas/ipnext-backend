import { Plan } from '../entities/plan';

export interface PlanUpsert {
  code: string;
  name: string;
  category: string;
  downloadKbps: number;
  uploadKbps: number;
  status?: string;
}

export interface PlanUpdate {
  name?: string;
  category?: string;
  downloadKbps?: number;
  uploadKbps?: number;
  status?: string;
}

export interface PlanRepository {
  upsertByCode(data: PlanUpsert): Promise<Plan>;
  list(): Promise<Plan[]>;
  findById(id: string): Promise<Plan | null>;
  findByCode(code: string): Promise<Plan | null>;
  delete(id: string): Promise<void>;
}
