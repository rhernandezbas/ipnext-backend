import { User } from '../entities/auth';

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface CookieConfig {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  maxAge: number;
  path: string;
}

export interface AuthProvider {
  login(credentials: LoginCredentials): Promise<{ user: User; cookieValue: string; cookieOptions: CookieConfig }>;
  logout(): { cookieOptions: CookieConfig };
  getSession(token: string): Promise<User>;
}
