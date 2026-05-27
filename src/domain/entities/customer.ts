export type CustomerStatus = 'active' | 'late' | 'blocked' | 'inactive';

export interface Customer {
  id: string;
  /** External Gestión Real client id, when this row came from the GR mirror. */
  grClienteId?: string | null;
  name: string;
  email: string;
  phone: string;
  status: CustomerStatus;
  address: string;
  city: string;
  country: string;
  login: string;
  createdAt: string;
  customAttributes?: Record<string, string>;
}

export interface Service {
  id: string;
  type: string;
  plan: string;
  ip: string;
  status: string;
  startDate: string;
  endDate: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

export interface ClientLog {
  id: string;
  timestamp: string;
  eventType: string;
  description: string;
}

export interface ClientComment {
  id: string;
  clientId: string;
  authorName: string;
  content: string;
  createdAt: string;
}
