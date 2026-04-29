export interface RolePermission {
  module: string;
  actions: ('read' | 'write' | 'delete')[];
}

export interface AdminRole_Definition {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: RolePermission[];
}
