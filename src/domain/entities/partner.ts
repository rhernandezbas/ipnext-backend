export interface Partner {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  primaryEmail: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  timezone: string;
  currency: string;
  logoUrl: string | null;
  clientCount: number;
  adminCount: number;
  createdAt: string;
}
