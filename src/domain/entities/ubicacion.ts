export interface Ubicacion {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  country: string;
  phone: string;
  email: string;
  manager: string;
  clientCount: number;
  status: 'active' | 'inactive';
  coordinates: { lat: number; lng: number } | null;
  timezone: string;
}
