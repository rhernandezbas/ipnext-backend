export interface MaterialCatalog {
  id: string;
  name: string;       // canonical UPPERCASE
  label: string | null;
  unit: string | null;
  active: boolean;
  sortOrder: number;
  /** Wave 7 (Capstone) — low-stock threshold. 0 = no alert configured. */
  minStock: number;
}
