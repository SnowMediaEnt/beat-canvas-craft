import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./client";

type AuthStatus = "loading" | "authed" | "anon";

interface AuthState {
  session: Session | null;
  user: User | null;
  status: AuthStatus;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

// Routes that render without a session. Everything else is gated.
const PUBLIC_PATHS = new Set<string>(["/login"]);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    let mounted = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session);
        setStatus(data.session ? "authed" : "anon");
      })
      .catch(() => {
        if (mounted) setStatus("anon");
      });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setStatus(next ? "authed" : "anon");
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, status, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

function FullScreenLoader() {
  return (
    <div className="min-h-screen grid place-items-center bg-background text-sm text-muted-foreground">
      Loading…
    </div>
  );
}

/**
 * Client-side access gate. While the session is resolving it renders a neutral
 * loader (identical on the server and the first client render, so hydration
 * never mismatches). Signed-out users on a non-public route are redirected to
 * /login. The real security boundary is server-side — every paid endpoint
 * validates the token independently — so this gate is UX, not the lock.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isPublic = PUBLIC_PATHS.has(pathname);

  useEffect(() => {
    if (status === "anon" && !isPublic) {
      navigate({ to: "/login", replace: true });
    }
  }, [status, isPublic, navigate]);

  if (isPublic) return <>{children}</>;
  if (status !== "authed") return <FullScreenLoader />;
  return <>{children}</>;
}
