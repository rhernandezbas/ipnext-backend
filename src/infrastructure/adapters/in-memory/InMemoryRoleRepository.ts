import { AdminRole_Definition } from '@domain/entities/role';
import { RoleRepository } from '@domain/ports/RoleRepository';

let nextId = 7;

const ALL_MODULES = ['clients', 'tickets', 'billing', 'network', 'scheduling', 'reports', 'settings', 'admins'];

export class InMemoryRoleRepository implements RoleRepository {
  private roles: AdminRole_Definition[] = [
    {
      id: '1',
      name: 'superadmin',
      description: 'Acceso total al sistema',
      isSystem: true,
      permissions: ALL_MODULES.map(module => ({
        module,
        actions: ['read', 'write', 'delete'] as ('read' | 'write' | 'delete')[],
      })),
    },
    {
      id: '2',
      name: 'admin',
      description: 'Administrador con acceso a la mayoría de módulos',
      isSystem: true,
      permissions: [
        { module: 'clients', actions: ['read', 'write'] },
        { module: 'tickets', actions: ['read', 'write'] },
        { module: 'billing', actions: ['read', 'write'] },
        { module: 'network', actions: ['read', 'write'] },
        { module: 'scheduling', actions: ['read', 'write'] },
        { module: 'settings', actions: ['read'] },
      ],
    },
    {
      id: '3',
      name: 'engineer',
      description: 'Técnico de red con acceso a red y scheduling',
      isSystem: true,
      permissions: [
        { module: 'network', actions: ['read', 'write'] },
        { module: 'scheduling', actions: ['read', 'write'] },
        { module: 'clients', actions: ['read'] },
      ],
    },
    {
      id: '4',
      name: 'financial_manager',
      description: 'Encargado de finanzas y reportes',
      isSystem: true,
      permissions: [
        { module: 'billing', actions: ['read', 'write'] },
        { module: 'reports', actions: ['read', 'write'] },
        { module: 'clients', actions: ['read'] },
      ],
    },
    {
      id: '5',
      name: 'customer_creator',
      description: 'Solo puede crear clientes',
      isSystem: true,
      permissions: [
        { module: 'clients', actions: ['write'] },
      ],
    },
    {
      id: '6',
      name: 'viewer',
      description: 'Solo lectura de clientes, tickets y facturación',
      isSystem: true,
      permissions: [
        { module: 'clients', actions: ['read'] },
        { module: 'tickets', actions: ['read'] },
        { module: 'billing', actions: ['read'] },
      ],
    },
  ];

  async findAll(): Promise<AdminRole_Definition[]> {
    return [...this.roles];
  }

  async findById(id: string): Promise<AdminRole_Definition | null> {
    return this.roles.find(r => r.id === id) ?? null;
  }

  async create(data: Omit<AdminRole_Definition, 'id'>): Promise<AdminRole_Definition> {
    const role: AdminRole_Definition = {
      ...data,
      id: String(nextId++),
    };
    this.roles.push(role);
    return role;
  }

  async update(id: string, data: Partial<AdminRole_Definition>): Promise<AdminRole_Definition | null> {
    const index = this.roles.findIndex(r => r.id === id);
    if (index === -1) return null;
    this.roles[index] = { ...this.roles[index], ...data };
    return this.roles[index];
  }

  async delete(id: string): Promise<boolean> {
    const index = this.roles.findIndex(r => r.id === id);
    if (index === -1) return false;
    this.roles.splice(index, 1);
    return true;
  }
}
