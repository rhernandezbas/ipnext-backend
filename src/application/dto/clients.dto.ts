import { Customer } from '@domain/entities/customer';

export interface ListClientsQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
}

/**
 * internal-catalogs-bridge — curated client DTO for the internal (unauthenticated)
 * catalogs bridge. Same allow-list as `toExternalClientDto`
 * (externalV1.routes.ts) — EXCLUDES grClienteId, login, customAttributes, and
 * all balance fields (internal/billing data, not needed to build an IClass
 * task payload).
 */
export interface ClientDto {
  id: string;
  name: string;
  email: string;
  phone: string;
  status: string;
  address: string;
  city: string;
  country: string;
  createdAt: string;
}

export function toClientDto(c: Customer): ClientDto {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    status: c.status,
    address: c.address,
    city: c.city,
    country: c.country,
    createdAt: c.createdAt,
  };
}
