import { ArrowLeft, LoaderCircle, LogOut, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DEFAULT_MAX_MEMBERS, MAX_MEMBERS_LIMIT, type AdminWorkspace } from "../../shared/protocol";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import logo from "../assets/logo.svg";
import { ApiRequestError } from "../api";
import { AuthCard, PasskeyAction } from "../auth/AuthScreens";
import { navigate, usePathname } from "../router";
import {
  createWorkspace,
  describeOwnerError,
  enrollOwnerPasskey,
  isOwnerSignedIn,
  listWorkspaces,
  signInOwner,
  signOutOwner,
} from "./adminApi";
import { WorkspaceDetail, statusBadge } from "./WorkspaceDetail";

type OwnerState = "loading" | "signed-out" | "signed-in";

/**
 * The owner's dashboard at /admin (M9, ADR 0006): workspaces, their members and member caps.
 * Signed in with the owner's passkey, which is enrolled once from `npm run admin:enroll`.
 */
export function AdminApp() {
  const pathname = usePathname();
  const [state, setState] = useState<OwnerState>("loading");

  useEffect(() => {
    isOwnerSignedIn()
      .then((signedIn) => setState(signedIn ? "signed-in" : "signed-out"))
      .catch(() => setState("signed-out"));
  }, []);

  const signedIn = () => {
    setState("signed-in");
    if (pathname === "/admin/enroll") navigate("/admin", { replace: true });
  };
  const sessionEnded = useCallback(() => setState("signed-out"), []);

  if (pathname === "/admin/enroll") return <EnrollScreen onEnrolled={signedIn} />;
  if (state === "loading") {
    return (
      <main className="flex min-h-svh items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
      </main>
    );
  }
  if (state === "signed-out") {
    return (
      <AuthCard title="Owner sign-in" description="The dashboard for Colo's workspaces opens with the owner's passkey.">
        <PasskeyAction
          label="Sign in with passkey"
          describeError={describeOwnerError}
          onRun={async () => {
            await signInOwner();
            signedIn();
          }}
        />
      </AuthCard>
    );
  }

  const signOut = async () => {
    await signOutOwner().catch(() => undefined);
    setState("signed-out");
  };
  const detail = /^\/admin\/w\/([^/]+)$/.exec(pathname);
  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3">
        <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <img src={logo} alt="" className="size-5" />
          Colo
          <span className="font-normal text-muted-foreground">· Owner dashboard</span>
        </span>
        <Button variant="outline" size="sm" onClick={signOut}>
          <LogOut data-icon="inline-start" />
          Sign out
        </Button>
      </header>
      <main className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-6">
        {detail ? (
          <>
            <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => navigate("/admin")}>
              <ArrowLeft data-icon="inline-start" />
              All workspaces
            </Button>
            <WorkspaceDetail slug={decodeURIComponent(detail[1])} onSessionEnded={sessionEnded} />
          </>
        ) : (
          <Workspaces onSessionEnded={sessionEnded} />
        )}
      </main>
    </div>
  );
}

function EnrollScreen({ onEnrolled }: { onEnrolled: () => void }) {
  // The token travels in the URL fragment, which browsers never send to the server.
  const token = location.hash.slice(1);
  if (!token) {
    return (
      <AuthCard title="Enrollment link incomplete" description="Open the full link, including the part after #.">
        <CardContent />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Add the owner's passkey" description="Creates a passkey on this device for Colo's owner dashboard.">
      <PasskeyAction
        label="Create passkey"
        describeError={describeOwnerError}
        onRun={async () => {
          await enrollOwnerPasskey(token);
          onEnrolled();
        }}
      />
    </AuthCard>
  );
}

function Workspaces({ onSessionEnded }: { onSessionEnded: () => void }) {
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    listWorkspaces()
      .then(setWorkspaces)
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 401) onSessionEnded();
        else setError(describeOwnerError(err));
      });
  }, [onSessionEnded]);
  useEffect(load, [load]);

  const people = (workspaces ?? []).filter((w) => !w.disabledAt).reduce((n, w) => n + w.members, 0);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>
        <Button onClick={() => setCreating(true)}>
          <Plus data-icon="inline-start" />
          New workspace
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="rounded-xl border bg-background">
        {workspaces === null ? (
          <div className="flex justify-center p-8 text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Members</TableHead>
                <TableHead>Documents</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((workspace) => (
                <TableRow
                  key={workspace.slug}
                  className="cursor-pointer"
                  onClick={() => navigate(`/admin/w/${encodeURIComponent(workspace.slug)}`)}
                >
                  <TableCell>
                    {/* A real link, so the row is reachable by keyboard and screen reader too. */}
                    <a
                      href={`/admin/w/${encodeURIComponent(workspace.slug)}`}
                      className="grid font-medium hover:underline"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        navigate(`/admin/w/${encodeURIComponent(workspace.slug)}`);
                      }}
                    >
                      {workspace.name}
                      <span className="font-mono text-xs font-normal text-muted-foreground">{workspace.slug}</span>
                    </a>
                  </TableCell>
                  <TableCell>
                    {workspace.members} / {workspace.maxMembers}
                  </TableCell>
                  <TableCell>{workspace.documents}</TableCell>
                  <TableCell>{statusBadge(workspace.disabledAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {people} {people === 1 ? "person" : "people"} can sign in across all workspaces. Every workspace shares this
        account's Workers Free allowance: about 20–25 people typing heavily each day in total, more if most of them
        mostly read.
      </p>
      <NewWorkspaceDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(workspace) => {
          setCreating(false);
          navigate(`/admin/w/${encodeURIComponent(workspace.slug)}`);
        }}
      />
    </>
  );
}

function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (workspace: AdminWorkspace) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [maxMembers, setMaxMembers] = useState(String(DEFAULT_MAX_MEMBERS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await createWorkspace({ name, slug: slug.trim().toLowerCase(), maxMembers: Number(maxMembers) }));
      setName("");
      setSlug("");
      setMaxMembers(String(DEFAULT_MAX_MEMBERS));
    } catch (err) {
      setError(describeOwnerError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>Its members see only its documents. Members type the workspace ID to sign in.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input id="workspace-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workspace-slug">Workspace ID</Label>
            <Input
              id="workspace-slug"
              required
              pattern="[a-z0-9][a-z0-9\-]{1,39}"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="design-team"
              value={slug}
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
            />
            <p className="text-xs text-muted-foreground">2–40 lower-case letters, digits and hyphens. You can change it later.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workspace-max">Maximum members</Label>
            <Input
              id="workspace-max"
              type="number"
              required
              min={1}
              max={MAX_MEMBERS_LIMIT}
              value={maxMembers}
              onChange={(event) => setMaxMembers(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <LoaderCircle className="animate-spin" data-icon="inline-start" />}
              Create workspace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
