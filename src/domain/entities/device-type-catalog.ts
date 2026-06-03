export interface DeviceTypeCatalog {
  id: string;
  name: string;       // canonical UPPERCASE
  label: string | null;
  active: boolean;
  sortOrder: number;
}
