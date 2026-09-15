import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { KeyRound, LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Member } from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import logo from "../assets/logo.svg";
import { describeAuthError, registerWithInvite, signInWithPasskey } from "../auth";

function AuthCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-10">
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
    </main>
  );
}

function PasskeyAction({ label, onRun }: { label: string; onRun: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRun();
    } catch (err) {
      setError(describeAuthError(err));
      setBusy(false);
    }
  };

  return (
    <>
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
      <CardFooter>
        <p className="text-xs text-muted-foreground">
          Uses your device's fingerprint, face or screen lock. Colo has no passwords.
        </p>
      </CardFooter>
    </>
  );
}

export function SignInScreen({ onSignedIn }: { onSignedIn: (member: Member) => void }) {
  return (
    <AuthCard title="Sign in" description="Colo is invite-only. Use the passkey you created from your invite.">
      <PasskeyAction label="Sign in with passkey" onRun={async () => onSignedIn(await signInWithPasskey())} />
    </AuthCard>
  );
}

export function InviteScreen({ onSignedIn }: { onSignedIn: (member: Member) => void }) {
  // The token travels in the URL fragment, which browsers never send to the server.
  const token = location.hash.slice(1);
  if (!token) {
    return (
      <AuthCard title="Invite link incomplete" description="Open the full link you were sent, including the part after #.">
        <CardContent />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Accept your invite" description="Create a passkey for Colo on this device to finish joining.">
      <PasskeyAction label="Create passkey" onRun={async () => onSignedIn(await registerWithInvite(token))} />
    </AuthCard>
  );
}
