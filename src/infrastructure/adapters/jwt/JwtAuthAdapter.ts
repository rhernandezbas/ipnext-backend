import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { AuthProvider, CookieConfig, LoginCredentials } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import { AuthenticationError } from '@domain/errors';
import { config } from '../../config';
import { prisma } from '../../database/prisma';

const COOKIE_NAME = 'auth_token';
const MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours

interface JwtPayload {
  userId: string;
  username: string;
  email: string;
  role: string;
}

export class JwtAuthAdapter implements AuthProvider {
  async login(credentials: LoginCredentials): Promise<{ user: User; cookieValue: string; cookieOptions: CookieConfig }> {
    const admin = await prisma.admin.findFirst({
      where: {
        OR: [
          { email: credentials.username },
          { name: credentials.username },
        ],
        status: 'active',
      },
    });

    if (!admin || !admin.passwordHash) {
      throw new AuthenticationError('Invalid credentials');
    }

    const valid = await bcrypt.compare(credentials.password, admin.passwordHash);
    if (!valid) {
      throw new AuthenticationError('Invalid credentials');
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLogin: new Date() },
    });

    const user: User = {
      id: admin.id,
      username: admin.name,
      email: admin.email,
      role: admin.role,
    };

    const payload: JwtPayload = { userId: user.id, username: user.username, email: user.email, role: user.role };
    const cookieValue = jwt.sign(payload, config.jwtSecret, { expiresIn: MAX_AGE_SECONDS });

    const cookieOptions: CookieConfig = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: MAX_AGE_SECONDS * 1000,
      path: '/',
    };

    return { user, cookieValue, cookieOptions };
  }

  logout(): { cookieOptions: CookieConfig } {
    return {
      cookieOptions: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 0,
        path: '/',
      },
    };
  }

  async getSession(token: string): Promise<User> {
    try {
      const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
      return {
        id: payload.userId,
        username: payload.username,
        email: payload.email,
        role: payload.role,
      };
    } catch {
      throw new AuthenticationError('Invalid or expired session');
    }
  }
}
