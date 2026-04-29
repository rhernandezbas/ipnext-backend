export interface User {
  id: string;
  username: string;
  email: string;
  role: string;
}

export interface AuthSession {
  user: User;
  token: string;
}
