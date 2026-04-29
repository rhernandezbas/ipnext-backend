export interface HardwareAsset {
  id: string;
  name: string;
  category: 'server' | 'switch' | 'router' | 'ups' | 'rack' | 'cable' | 'sfp' | 'other';
  serialNumber: string;
  model: string;
  manufacturer: string;
  purchaseDate: string;
  purchasePrice: number;
  warrantyExpiry: string | null;
  location: string;
  networkSiteId: string | null;
  status: 'in_use' | 'spare' | 'maintenance' | 'retired';
  assignedTo: string | null;
  notes: string;
}
