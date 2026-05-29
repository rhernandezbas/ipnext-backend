export interface User {
  id: string;
  username: string;
  email: string;
  /** @deprecated Legacy field from Admin-based auth. No longer populated by JwtAuthAdapter.
   * Kept as optional to avoid breaking callers that read but don't require it. */
  role?: string;
}

export interface AuthSession {
  user: User;
  token: string;
}
