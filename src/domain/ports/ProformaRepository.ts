import { ProformaInvoice } from '../entities/billing';

export interface ProformaRepository {
  findAll(): Promise<ProformaInvoice[]>;
  findById(id: string): Promise<ProformaInvoice | null>;
  create(data: Omit<ProformaInvoice, 'id'>): Promise<ProformaInvoice>;
  update(id: string, data: Partial<ProformaInvoice>): Promise<ProformaInvoice | null>;
}
