/**
 * rbacUser.routes.ts — HTTP router for /admin/rbac/users
 *
 * SDD #2 — Phase 6 (BE Capability 3).
 * First production mount of requirePerm('admin', 'manage').
 *
 * Design notes:
 * - All 10 use cases are injected via RbacUserRouterDeps (DIP: no Prisma imports here).
 * - Error handling is delegated to the global errorHandler via next(err).
 *   The statusMap in errorHandler.ts handles all domain error code → HTTP status mappings.
 * - Route ordering: /:id/roles routes are registered BEFORE /:id catch-all (Express order).
 * - DELETE /:id passes req.user!.id as requestingUserId (safe: requirePerm already ensured
 *   req.user.id exists).
 * - POST /:id/password resolves isAdminManaged = (req.params.id !== req.user!.id).
 */

import { Router, Request, Response, NextFunction } from 'express';
import type { ListRbacUsers } from '@application/use-cases/rbac/ListRbacUsers';
import type { GetRbacUser } from '@application/use-cases/rbac/GetRbacUser';
import type { CreateRbacUser } from '@application/use-cases/rbac/CreateRbacUser';
import type { UpdateRbacUser } from '@application/use-cases/rbac/UpdateRbacUser';
import type { DeleteRbacUser } from '@application/use-cases/rbac/DeleteRbacUser';
import type { ChangeRbacUserPassword } from '@application/use-cases/rbac/ChangeRbacUserPassword';
import type { ListRolesForUser } from '@application/use-cases/rbac/ListRolesForUser';
import type { SetRolesForUser } from '@application/use-cases/rbac/SetRolesForUser';
import type { AssignRoleToUser } from '@application/use-cases/rbac/AssignRoleToUser';
import type { RemoveRoleFromUser } from '@application/use-cases/rbac/RemoveRoleFromUser';
import type { UnlockRbacUser } from '@application/use-cases/rbac/UnlockRbacUser';

export interface RbacUserRouterDeps {
  listUsers: ListRbacUsers;
  getUser: GetRbacUser;
  createUser: CreateRbacUser;
  updateUser: UpdateRbacUser;
  deleteUser: DeleteRbacUser;
  changePassword: ChangeRbacUserPassword;
  listRolesForUser: ListRolesForUser;
  setRolesForUser: SetRolesForUser;
  assignRoleToUser: AssignRoleToUser;
  removeRoleFromUser: RemoveRoleFromUser;
  unlockUser: UnlockRbacUser;
}

export function createRbacUserRouter(deps: RbacUserRouterDeps): Router {
  const router = Router();

  // ---------------------------------------------------------------------------
  // GET / — list all users
  // ---------------------------------------------------------------------------
  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const users = await deps.listUsers.execute();
      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // POST / — create a user
  // ---------------------------------------------------------------------------
  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name, email, login, password, status, roleIds } = req.body as {
        name: string;
        email: string;
        login: string;
        password: string;
        status?: 'active' | 'disabled';
        roleIds: string[];
      };
      const user = await deps.createUser.execute({ name, email, login, password, status, roleIds });
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // Sub-resource routes MUST come before /:id catch-all (Express order matters)
  // ---------------------------------------------------------------------------

  // GET /:id/roles — list roles for a user
  router.get('/:id/roles', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const roles = await deps.listRolesForUser.execute(req.params['id'] as string);
      res.json({ roles });
    } catch (err) {
      next(err);
    }
  });

  // PUT /:id/roles — bulk replace roles (SetRolesForUser)
  router.put('/:id/roles', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { roleIds } = req.body as { roleIds: string[] };
      const roles = await deps.setRolesForUser.execute(req.params['id'] as string, roleIds);
      res.json({ roles });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/roles — assign a single role
  router.post('/:id/roles', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { roleId } = req.body as { roleId: string };
      await deps.assignRoleToUser.execute(req.params['id'] as string, roleId);
      // Fetch the assigned role to return it
      const roles = await deps.listRolesForUser.execute(req.params['id'] as string);
      const assignedRole = roles.find(r => r.id === roleId);
      res.json({ role: assignedRole });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /:id/roles/:roleId — remove a single role
  router.delete('/:id/roles/:roleId', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deps.removeRoleFromUser.execute(req.params['id'] as string, req.params['roleId'] as string);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/unlock — reset account lockout (failedLoginCount=0, lockedUntil=null)
  router.post('/:id/unlock', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await deps.unlockUser.execute(req.params['id'] as string);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  // POST /:id/password — change password (admin-managed or self-change)
  router.post('/:id/password', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const requestingUserId = req.user!.id;
      const targetId = req.params['id'] as string;
      const isAdminManaged = targetId !== requestingUserId;
      const { newPassword, oldPassword } = req.body as { newPassword: string; oldPassword?: string };
      await deps.changePassword.execute(targetId, { newPassword, oldPassword }, isAdminManaged);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // /:id routes (catch-all — must come AFTER sub-resource routes)
  // ---------------------------------------------------------------------------

  // GET /:id — get a single user with roles
  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await deps.getUser.execute(req.params['id'] as string);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /:id — update user (partial)
  router.patch('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { name, email, login, status, password } = req.body as {
        name?: string;
        email?: string;
        login?: string;
        status?: 'active' | 'disabled';
        password?: string;
      };
      const user = await deps.updateUser.execute(req.params['id'] as string, { name, email, login, status, password });
      res.json({ user });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /:id — delete user
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const requestingUserId = req.user!.id;
      await deps.deleteUser.execute(req.params['id'] as string, requestingUserId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
