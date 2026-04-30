export interface Project {
  id: string;
  title: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  taskCounts?: {
    nuevo: number;
    enProgreso: number;
    hecho: number;
    total: number;
  };
}
