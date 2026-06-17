import { PppoeService } from '../entities/pppoeService';

export interface PppoeServiceUpsert {
  username: string;
  password: string;
  profile?: string | null;
  remoteAddress?: string | null;
  status?: string;
  nasId: string;
  contractId?: string | null;
}

export interface PppoeServiceRepository {
  /** Idempotente por `username`: crea o actualiza la fila existente. */
  upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService>;
  list(): Promise<PppoeService[]>;
  findByUsername(username: string): Promise<PppoeService | null>;
  findByContract(contractId: string): Promise<PppoeService[]>;
}
