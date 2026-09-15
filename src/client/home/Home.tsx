import { LogOut } from "lucide-react";
import type { Member } from "../../shared/protocol";
import { Button } from "@/components/ui/button";

export function Home({ member, onSignOut }: { member: Member; onSignOut: () => void }) {
  return (
    <div className="min-h-svh bg-muted/40">
      <header className="flex items-center justify-between border-b bg-background px-4 py-3">
        <span className="text-lg font-semibold tracking-tight">Colo</span>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{member.displayName}</span>
          <Button variant="outline" size="sm" onClick={onSignOut}>
            <LogOut data-icon="inline-start" />
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {member.displayName}</h1>
        <p className="text-muted-foreground">Documents arrive in M2.</p>
      </main>
    </div>
  );
}
