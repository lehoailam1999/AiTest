import { apiFetch, session } from "./client";

export type User = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  isActive: boolean;
};

export type AuthResponse = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  user: User;
};

export function login(email: string, password: string) {
  return apiFetch<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function register(
  email: string,
  password: string,
  firstName: string,
  lastName: string
) {
  return apiFetch<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, firstName, lastName }),
  });
}

export function me(accessToken: string) {
  return apiFetch<User>("/auth/me", { method: "GET" }, accessToken);
}

export function logout(accessToken: string) {
  return apiFetch<{ status: string }>(
    "/auth/logout",
    { method: "POST" },
    accessToken
  );
}

export function refresh(refreshToken: string) {
  return apiFetch<AuthResponse>("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
}

export { session };
