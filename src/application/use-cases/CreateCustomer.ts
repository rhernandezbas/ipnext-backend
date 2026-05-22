import { CustomerRepository, CreateCustomerInput } from '@domain/ports/CustomerRepository';
import { Customer } from '@domain/entities/customer';

export interface CreateCustomerCommand {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  status?: 'active' | 'inactive' | 'blocked' | 'new';
  login?: string;
  splynxId?: string | null;
}

function deriveLogin(firstName: string, lastName: string, email: string): string {
  const emailLocal = email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  if (emailLocal && emailLocal.length >= 3) return emailLocal;
  const first = firstName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const last = lastName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${first.charAt(0)}${last}` || `client-${Date.now()}`;
}

export class CreateCustomer {
  constructor(private readonly repo: CustomerRepository) {}

  async execute(cmd: CreateCustomerCommand): Promise<Customer> {
    const name = `${cmd.firstName.trim()} ${cmd.lastName.trim()}`.trim();
    const login = cmd.login?.trim() || deriveLogin(cmd.firstName, cmd.lastName, cmd.email);

    const input: CreateCustomerInput = {
      name,
      email: cmd.email.trim(),
      phone: cmd.phone.trim(),
      login,
      status: cmd.status ?? 'active',
      address: cmd.address ?? null,
      city: cmd.city ?? null,
      country: cmd.country ?? null,
      splynxId: cmd.splynxId ?? null,
    };
    return this.repo.create(input);
  }
}
