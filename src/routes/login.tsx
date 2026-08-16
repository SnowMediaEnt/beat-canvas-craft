import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/integrations/supabase/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [{ title: "Sign in · Pulse" }],
  }),
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const { status } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in → leave the login page.
  useEffect(() => {
    if (status === "authed") nav({ to: "/", replace: true });
  }, [status, nav]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    nav({ to: "/", replace: true });
  };

  return (
    <div className="min-h-screen grid place-items-center bg-background px-4">
      <Card className="panel w-full max-w-sm p-8">
        <div className="flex items-center gap-2.5 mb-6">
          <div className="size-9 rounded-lg bg-gradient-to-br from-primary to-accent grid place-items-center">
            <Sparkles className="size-4 text-primary-foreground" />
          </div>
          <div>
            <div className="font-display font-bold text-lg leading-none">Pulse</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-widest">
              Sign in to continue
            </div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
