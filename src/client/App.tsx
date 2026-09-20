import { LoaderCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { Member } from "../shared/protocol";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InviteScreen, SignInScreen } from "./auth/AuthScreens";
import { fetchMe, signOut } from "./auth";
import { DocumentPage } from "./doc/DocumentPage";
import { Home } from "./home/Home";
import { navigate, usePathname } from "./router";

type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; member: Member };

/**
 * Click-to-annotate feedback for whoever is coding against this app (`agentation`, dev-only —
 * see package.json). `import.meta.env.DEV` is `false` for both `vite build` and `vite preview`,
 * and Vite inlines it as a literal at build time, so the branch below — and this whole ~660 KB
 * chunk — is dead code the production build never reaches, let alone ships. It never runs
 * against a deployed Worker either way: `npm run dev` is the only thing that serves un-built
 * source, and that is the only place `import.meta.env.DEV` is true.
 */
const DevFeedback = import.meta.env.DEV ? lazy(() => import("agentation").then((m) => ({ default: m.Agentation }))) : null;

export default function App() {
  return (
    <TooltipProvider delayDuration={400}>
      <Routes />
      {DevFeedback && (
        <Suspense fallback={null}>
          <DevFeedback />
        </Suspense>
      )}
    </TooltipProvider>
  );
}

function Routes() {
  const pathname = usePathname();
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  // The first check only settles the loading state. Registering on the invite screen can finish
  // before its answer arrives, and a late "not signed in" must not undo that sign-in.
  useEffect(() => {
    const settle = (next: AuthState) => setAuth((current) => (current.status === "loading" ? next : current));
    fetchMe()
      .then((member) => settle(member ? { status: "signed-in", member } : { status: "signed-out" }))
      .catch(() => settle({ status: "signed-out" }));
  }, []);

  const onSignedIn = (member: Member) => {
    setAuth({ status: "signed-in", member });
    if (pathname === "/invite") navigate("/", { replace: true });
  };

  // Keeps the current path so signing back in returns to the same document.
  const onSessionEnded = useCallback(() => setAuth({ status: "signed-out" }), []);

  const onSignOut = async () => {
    await signOut().catch(() => undefined);
    setAuth({ status: "signed-out" });
    navigate("/", { replace: true });
  };

  if (pathname === "/invite") return <InviteScreen onSignedIn={onSignedIn} />;

  if (auth.status === "loading") {
    return (
      <main className="flex min-h-svh items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" aria-label="Loading" />
      </main>
    );
  }
  if (auth.status === "signed-out") return <SignInScreen onSignedIn={onSignedIn} />;

  const docMatch = /^\/d\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(pathname);
  if (docMatch) {
    return <DocumentPage docId={docMatch[1]} member={auth.member} onSessionEnded={onSessionEnded} />;
  }
  return <Home member={auth.member} onSignOut={onSignOut} onSessionEnded={onSessionEnded} />;
}
