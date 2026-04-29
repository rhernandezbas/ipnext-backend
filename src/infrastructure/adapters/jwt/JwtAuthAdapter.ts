import jwt from 'jsonwebtoken';
import { AuthProvider, CookieConfig, LoginCredentials } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import { AuthenticationError } from '@domain/errors';
import { config } from '../../config';
import { SplynxClient } from '../splynx/SplynxClient';

const COOKIE_NAME = 'auth_token';
const MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours

interface JwtPayload {
  userId: string;
  username: string;
  email: string;
  role: string;
}

export class JwtAuthAdapter implements AuthProvider {
  constructor(private readonly splynxClient: SplynxClient) {}

  async login(credentials: LoginCredentials): Promise<{ user: User; cookieValue: string; cookieOptions: CookieConfig }> {
    // Authenticate against Splynx
    let splynxUser: Record<string, unknown>;
    try {
      splynxUser = await this.splynxClient.post<Record<string, unknown>>('/api/2.0/admin/auth/login', {
        login: credentials.username,
        password: credentials.password,
      });
    } catch {
      throw new AuthenticationError('Invalid credentials');
    }

    if (!splynxUser || !splynxUser['admin_id']) {
      throw new AuthenticationError('Invalid credentials');
    }

    const user: User = {
      id: String(splynxUser['admin_id']),
      username: credentials.username,
      email: String(splynxUser['email'] ?? ''),
      role: String(splynxUser['role'] ?? 'admin'),
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
