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
  /**
   * Devuelve todos los planes. El ORDEN NO ESTÁ GARANTIZADO por este port:
   * cada adapter devuelve el orden natural de su backing store (Prisma: orden
   * de la DB; in-memory: orden de inserción). El orden de presentación del
   * catálogo es responsabilidad del use case (ver ListPlans).
   */
  list(): Promise<Plan[]>;
  findById(id: string): Promise<Plan | null>;
  findByCode(code: string): Promise<Plan | null>;
  delete(id: string): Promise<void>;
}
