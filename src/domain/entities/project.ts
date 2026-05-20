export interface Project {
  id: string;
  title: string;
  description: string | null;
  typeId: string | null;
  categoryId: string | null;
  workflowId: string | null;
  projectLeadId: string | null;
  visible: boolean;
  partners: Array<{ id: string; name: string }>;
  taskCounts?: {
    nuevo: number;
    enProgreso: number;
    hecho: number;
    total: number;
  };
  createdAt: string;
  updatedAt: string;
}
