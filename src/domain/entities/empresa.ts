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

export interface InventoryItem {
  id: string;
  name: string;
  category: 'router' | 'cable' | 'splitter' | 'onu' | 'tools' | 'other';
  sku: string;
  quantity: number;
  minStock: number;         // alert when below this
  unitPrice: number;
  supplier: string;
  location: string;
  status: 'in_stock' | 'low_stock' | 'out_of_stock';
}

// Catalog entry (what a product IS)
export interface InventoryProduct {
  id: string;
  name: string;
  category: 'router' | 'cable' | 'splitter' | 'onu' | 'tools' | 'other';
  sku: string;
  description: string;
  unitPrice: number;
  supplier: string;
  totalStock: number;       // computed from items
  minStock: number;
  status: 'in_stock' | 'low_stock' | 'out_of_stock';
}

// Physical unit instance
export interface InventoryUnit {
  id: string;
  productId: string;
  productName: string;
  serialNumber: string | null;
  barcode: string | null;
  status: 'available' | 'assigned' | 'damaged' | 'retired';
  location: string;
  purchaseDate: string | null;
  purchasePrice: number | null;
  assignedToClientId: string | null;
  assignedAt: string | null;
  notes: string;
}
