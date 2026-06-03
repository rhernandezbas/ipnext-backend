export interface MaterialCatalog {
  id: string;
  name: string;       // canonical UPPERCASE
  label: string | null;
  unit: string | null;
  active: boolean;
  sortOrder: number;
}
