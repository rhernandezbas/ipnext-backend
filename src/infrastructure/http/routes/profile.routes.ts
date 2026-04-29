import { Router, Request, Response } from 'express';
import { auth } from '../middleware/auth.middleware';

// In-memory profile store
const adminProfile = {
  id: 1,
  name: 'Admin Principal',
  email: 'admin@ipnext.com.ar',
  phone: '+54 11 4567-8901',
  role: 'Superadministrador',
  language: 'es',
  timezone: 'America/Argentina/Buenos_Aires',
  twoFactorEnabled: false,
  avatarInitials: 'AP',
  createdAt: '2023-01-15',
  lastLogin: '2026-04-28T11:00:00Z',
};

let profilePassword = 'admin123'; // stored separately

export function profileRoutes(router: Router) {
  router.get('/profile', auth, (_req: Request, res: Response): void => {
    const { ...safeProfile } = adminProfile;
    res.json(safeProfile);
  });

  router.patch('/profile', auth, (req: Request, res: Response): void => {
    const { name, email, phone, language, timezone } = req.body;
    if (name !== undefined) adminProfile.name = name;
    if (email !== undefined) adminProfile.email = email;
    if (phone !== undefined) adminProfile.phone = phone;
    if (language !== undefined) adminProfile.language = language;
    if (timezone !== undefined) adminProfile.timezone = timezone;
    res.json(adminProfile);
  });

  router.patch('/profile/password', auth, (req: Request, res: Response): void => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'currentPassword and newPassword are required' });
      return;
    }
    if (currentPassword !== profilePassword) {
      res.status(401).json({ error: 'Contraseña actual incorrecta' });
      return;
    }
    profilePassword = newPassword;
    res.json({ message: 'Contraseña actualizada' });
  });

  router.patch('/profile/2fa', auth, (req: Request, res: Response): void => {
    const { enabled } = req.body;
    adminProfile.twoFactorEnabled = !!enabled;
    res.json({ twoFactorEnabled: adminProfile.twoFactorEnabled });
  });
}
