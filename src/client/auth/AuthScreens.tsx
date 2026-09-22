import { Blobatar } from "@blobatar/react";
import { useGaze } from "@blobatar/react/gaze";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import "blobatar/gaze.css";
import "blobatar/motion.css";
import { KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { MeResponse } from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import logo from "../assets/logo.svg";
import { describeAuthError, lastWorkspace, rememberWorkspace, signIn } from "../auth";
import { authIllustration } from "./illustration";
import { authSeed } from "./seed";

export function AuthCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  // travel: 3 is the library's own single-avatar example — 3% of the face, comfortably inside
  // its recommended 1.5-4 range before the eyes reach the edge of the silhouette.
  const { ref } = useGaze({ travel: 3, lookAt: "pointer" });
  return (
    <main className="flex h-svh overflow-hidden">
      <div className="relative flex w-full items-center justify-center overflow-y-auto bg-muted/40 px-4 py-10 lg:w-1/2">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <p className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <img src={logo} alt="" className="size-6" />
              Colo
            </p>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          {children}
        </Card>
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2">
          <Blobatar ref={ref} name={authSeed} size={72} background="circle" animate="always" title="" />
        </div>
      </div>
      <div className="hidden overflow-hidden lg:flex lg:w-1/2 lg:items-center lg:justify-center">
        <img src={authIllustration} alt="" className="w-full" />
      </div>
    </main>
  );
}

/** A passkey ceremony behind one button; used by the owner's dashboard (M9). */
export function PasskeyAction({
  label,
  onRun,
  describeError,
}: {
  label: string;
  onRun: () => Promise<void>;
  describeError: (error: unknown) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRun();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <CardContent className="grid gap-3">
      <Button size="lg" className="w-full" onClick={run} disabled={busy || !supported}>
        {busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
        {label}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!supported && <p className="text-sm text-destructive">This browser does not support passkeys.</p>}
    </CardContent>
  );
}

/** Workspace ID, email and password (M9). The owner hands out all three from the dashboard. */
export function SignInScreen({ onSignedIn }: { onSignedIn: (me: MeResponse) => void }) {
  const [workspace, setWorkspace] = useState(lastWorkspace);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await signIn(workspace.trim().toLowerCase(), email.trim(), password);
      rememberWorkspace(me.workspace.slug);
      onSignedIn(me);
    } catch (err) {
      setError(describeAuthError(err));
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" description="Use the workspace ID, email and password you were given.">
      <form onSubmit={submit}>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="sign-in-workspace">Workspace ID</Label>
            <Input
              id="sign-in-workspace"
              name="workspace"
              autoComplete="organization"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sign-in-email">Email</Label>
            <Input
              id="sign-in-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sign-in-password">Password</Label>
            <Input
              id="sign-in-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <LogIn data-icon="inline-start" />}
            Sign in
          </Button>
        </CardFooter>
      </form>
    </AuthCard>
  );
}
