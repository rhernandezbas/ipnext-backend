export interface ServiceCatalog {
  id: string;
  name: string;       // canonical UPPERCASE
  label: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: string;  // ISO 8601
  updatedAt: string;  // ISO 8601
}
