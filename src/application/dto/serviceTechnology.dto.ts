import { z } from 'zod';
import { ServiceTechnology } from '@domain/entities/serviceTechnology';

export const CreateServiceTechnologySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
});

export const UpdateServiceTechnologySchema = CreateServiceTechnologySchema.partial();

export type CreateServiceTechnologyInput = z.infer<typeof CreateServiceTechnologySchema>;
export type UpdateServiceTechnologyInput = z.infer<typeof UpdateServiceTechnologySchema>;

export type ServiceTechnologyDTO = ServiceTechnology;
