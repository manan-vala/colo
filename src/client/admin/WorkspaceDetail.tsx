import { Check, Copy, KeyRound, LoaderCircle, MoreHorizontal, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  MAX_MEMBERS_LIMIT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type AdminMember,
  type AdminWorkspace,
} from "../../shared/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiRequestError } from "../api";
import { timeAgo } from "../lib/time";
import { navigate } from "../router";
import { addMember, describeOwnerError, listMembers, listWorkspaces, updateMember, updateWorkspace } from "./adminApi";

export function statusBadge(disabledAt: string | null) {
  return disabledAt ? <Badge variant="destructive">Disabled</Badge> : <Badge variant="secondary">Active</Badge>;
}

/** A password the owner has just set: shown once, with what the member needs to sign in. */
type Reveal = { email: string; slug: string; password: string };

export function WorkspaceDetail({ slug, onSessionEnded }: { slug: string; onSessionEnded: () => void }) {
  const [workspace, setWorkspace] = useState<AdminWorkspace | null>(null);
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiRequestError && err.status === 401) onSessionEnded();
      else setError(describeOwnerError(err));
    },
    [onSessionEnded],
  );

  const load = useCallback(() => {
    Promise.all([listWorkspaces(), listMembers(slug)])
      .then(([all, list]) => {
        setWorkspace(all.find((w) => w.slug === slug) ?? null);
        setMembers(list);
      })
      .catch(fail);
  }, [slug, fail]);
  useEffect(load, [load]);

  const memberAction = async (member: AdminMember, change: { disabled?: boolean; password?: true }) => {
    setError(null);
    try {
      const result = await updateMember(slug, member.id, change);
      if (result.password) setReveal({ email: member.email, slug, password: result.password });
      load();
    } catch (err) {
      fail(err);
    }
  };

  if (!workspace || !members) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : (
      <div className="flex justify-center p-8 text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
      </div>
    );
  }

  const full = workspace.members >= workspace.maxMembers;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {workspace.name} {statusBadge(workspace.disabledAt)}
          </h1>
          <p className="text-sm text-muted-foreground">
            Workspace ID <span className="font-mono text-foreground">{workspace.slug}</span> · {workspace.documents}{" "}
            {workspace.documents === 1 ? "document" : "documents"}
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <section className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">
            Members{" "}
            <span className="font-normal text-muted-foreground">
              {workspace.members} of {workspace.maxMembers}
            </span>
          </h2>
          <Button onClick={() => setAdding(true)} disabled={full} title={full ? "The workspace is full" : undefined}>
            <UserPlus data-icon="inline-start" />
            Add member
          </Button>
        </div>
        <div className="rounded-xl border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    No members yet.
                  </TableCell>
                </TableRow>
              )}
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="grid">
                      <span className="font-medium">{member.displayName}</span>
                      <span className="text-xs text-muted-foreground">{member.email}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {member.disabledAt ? (
                      <Badge variant="destructive">Disabled</Badge>
                    ) : member.hasPassword ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline">No password</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {member.lastLoginAt ? timeAgo(member.lastLoginAt) : "Never"}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.displayName}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => memberAction(member, { password: true })}>
                          <KeyRound />
                          {member.hasPassword ? "Reset password" : "Set password"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant={member.disabledAt ? "default" : "destructive"}
                          disabled={Boolean(member.disabledAt) && full}
                          onSelect={() => memberAction(member, { disabled: !member.disabledAt })}
                        >
                          {member.disabledAt ? "Enable" : "Disable and sign out"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <WorkspaceSettings
        workspace={workspace}
        onSaved={(saved) => {
          if (saved.slug !== slug) navigate(`/admin/w/${encodeURIComponent(saved.slug)}`, { replace: true });
          else setWorkspace(saved);
        }}
        onError={fail}
      />

      <AddMemberDialog
        open={adding}
        onOpenChange={setAdding}
        slug={slug}
        onAdded={(email, password) => {
          setAdding(false);
          setReveal({ email, slug, password });
          load();
        }}
      />
      <PasswordReveal reveal={reveal} onClose={() => setReveal(null)} />
    </>
  );
}

function WorkspaceSettings({
  workspace,
  onSaved,
  onError,
}: {
  workspace: AdminWorkspace;
  onSaved: (workspace: AdminWorkspace) => void;
  onError: (error: unknown) => void;
}) {
  const [name, setName] = useState(workspace.name);
  const [slug, setSlug] = useState(workspace.slug);
  const [maxMembers, setMaxMembers] = useState(String(workspace.maxMembers));
  const [busy, setBusy] = useState(false);

  const save = async (change: Parameters<typeof updateWorkspace>[1]) => {
    setBusy(true);
    try {
      onSaved(await updateWorkspace(workspace.slug, change));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save({ name, slug: slug.trim().toLowerCase(), maxMembers: Number(maxMembers) });
  };

  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">Settings</h2>
      <form onSubmit={submit} className="grid gap-4 rounded-xl border bg-background p-4 sm:grid-cols-3">
        <div className="grid gap-2">
          <Label htmlFor="settings-name">Name</Label>
          <Input id="settings-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="settings-slug">Workspace ID</Label>
          <Input
            id="settings-slug"
            required
            pattern="[a-z0-9][a-z0-9\-]{1,39}"
            autoCapitalize="none"
            spellCheck={false}
            value={slug}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="settings-max">Maximum members</Label>
          <Input
            id="settings-max"
            type="number"
            required
            min={Math.max(1, workspace.members)}
            max={MAX_MEMBERS_LIMIT}
            value={maxMembers}
            onChange={(event) => setMaxMembers(event.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-3">
          Changing the ID doesn't sign anyone out, but members must type the new one next time they sign in.
        </p>
        <div className="flex flex-wrap justify-between gap-3 sm:col-span-3">
          <Button
            type="button"
            variant={workspace.disabledAt ? "outline" : "destructive"}
            disabled={busy}
            onClick={() => save({ disabled: !workspace.disabledAt })}
          >
            {workspace.disabledAt ? "Enable workspace" : "Disable workspace and sign everyone out"}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <LoaderCircle className="animate-spin" data-icon="inline-start" />}
            Save changes
          </Button>
        </div>
      </form>
    </section>
  );
}

function AddMemberDialog({
  open,
  onOpenChange,
  slug,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  onAdded: (email: string, password: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await addMember(slug, { name, email, password: password || undefined });
      onAdded(result.member.email, result.password!);
      setName("");
      setEmail("");
      setPassword("");
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
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>They sign in with this workspace's ID, their email and the password.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="member-name">Name</Label>
            <Input id="member-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="member-email">Email</Label>
            <Input
              id="member-email"
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="member-password">Password</Label>
            <Input
              id="member-password"
              type="text"
              autoComplete="off"
              spellCheck={false}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              placeholder="Leave empty to generate one"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
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
              Add member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordReveal({ reveal, onClose }: { reveal: Reveal | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [reveal]);
  const details = reveal ? `Workspace ID: ${reveal.slug}\nEmail: ${reveal.email}\nPassword: ${reveal.password}` : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
    } catch {
      // Clipboard refused (permissions, an insecure context): the text is there to select by hand.
    }
  };

  return (
    <Dialog open={reveal !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send these sign-in details</DialogTitle>
          <DialogDescription>
            Colo stores only a hash of the password, so this is the only time it can be shown. Send it privately.
          </DialogDescription>
        </DialogHeader>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-3 font-mono text-sm select-all" data-testid="password-reveal">
          {details}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={copy}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
