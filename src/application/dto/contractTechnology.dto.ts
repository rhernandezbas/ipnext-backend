import { z } from 'zod';
import { ContractTechnology } from '@domain/entities/contractTechnology';

export const CreateContractTechnologySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});

export const UpdateContractTechnologySchema = CreateContractTechnologySchema.partial();

export type CreateContractTechnologyInput = z.infer<typeof CreateContractTechnologySchema>;
export type UpdateContractTechnologyInput = z.infer<typeof UpdateContractTechnologySchema>;

export type ContractTechnologyDTO = ContractTechnology;
