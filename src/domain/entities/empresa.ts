export type PlanSubtype = 'internet' | 'voice' | 'recurring' | 'onetime' | 'bundle';

export interface ServicePlan {
  id: string;
  name: string;
  type: 'internet' | 'voip' | 'tv' | 'other';
  planSubtype: PlanSubtype;
  downloadSpeed: number;    // Mbps
  uploadSpeed: number;      // Mbps
  price: number;            // ARS
  billingCycle: 'monthly' | 'quarterly' | 'yearly';
  status: 'active' | 'inactive';
  description: string;
  subscriberCount: number;
}

export interface NetworkDevice {
  id: string;
  name: string;
  type: 'router' | 'switch' | 'onu' | 'olt' | 'access_point' | 'other';
  ipAddress: string;
  macAddress: string;
  location: string;
  status: 'online' | 'offline' | 'warning';
  model: string;
  lastSeen: string;         // ISO date string
}

// InventoryItem, InventoryProduct, InventoryUnit removed (Wave 7 — World A retirement).
// Legacy DB tables are kept (no DROP), but all application code is removed.
