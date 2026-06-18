import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api } from "../api/client";
import { HttpError, setUnauthorizedHandler } from "../api/client";
import type { User } from "../api/types";
import { useAsync } from "../hooks/useAsync";

interface UserCtx {
  user: User | null;
  loading: boolean;
  unauthenticated: boolean;
  reload: () => void;
}

const Ctx = createContext<UserCtx>({
  user: null,
  loading: true,
  unauthenticated: false,
  reload: () => {},
});

export function UserProvider({ children }: { children: ReactNode }) {
  const { data, error, loading, reload } = useAsync(() => api.me(), []);
  const unauthenticated = error instanceof HttpError && error.status === 401;

  // Mid-session expiry: once a user is established, a later 401 means the session
  // died while working. Bounce to login and return to the current page. Guarded
  // by `data` so the initial unauthenticated load shows the LoginScreen instead
  // of auto-redirecting to the IdP.
  useEffect(() => {
    if (!data) return;
    setUnauthorizedHandler(() => {
      const here = window.location.pathname + window.location.search;
      window.location.assign(api.loginUrl(here));
    });
    return () => setUnauthorizedHandler(null);
  }, [data]);

  return (
    <Ctx.Provider value={{ user: data, loading, unauthenticated, reload }}>
      {children}
    </Ctx.Provider>
  );
}

export function useUser() {
  return useContext(Ctx);
}

// canModify holds for the "owner/provisioner" of a resource: admins, or members
// of the team. Gates publication ownership and order create/delete affordances.
// Support is intentionally NOT included here (it edits but never provisions).
export function canModify(user: User | null, team: string): boolean {
  if (!user) return false;
  return user.role === "admin" || (user.teams ?? []).includes(team);
}

// canEditOrder gates editing an existing order (values, rename, upgrade). Support
// edits orders of every team; admins and the team's own members also qualify.
export function canEditOrder(user: User | null, team: string): boolean {
  if (!user) return false;
  return user.role === "admin" || user.role === "support" || (user.teams ?? []).includes(team);
}
