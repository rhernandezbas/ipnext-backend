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
  /** FK to IClassSoType. Null when no mapping has been assigned. */
  iclassSoTypeId: string | null;
  /** Resolved IClass SO type — present when iclassSoTypeId is non-null. */
  iclassSoType: { id: string; code: string; description: string; active: boolean } | null;
  createdAt: string;
  updatedAt: string;
}
