import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { Member } from "../shared/protocol";
import { InviteScreen, SignInScreen } from "./auth/AuthScreens";
import { fetchMe, signOut } from "./auth";
import { Home } from "./home/Home";
import { navigate, usePathname } from "./router";

type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; member: Member };

export default function App() {
  const pathname = usePathname();
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    fetchMe()
      .then((member) => setAuth(member ? { status: "signed-in", member } : { status: "signed-out" }))
      .catch(() => setAuth({ status: "signed-out" }));
  }, []);

  const onSignedIn = (member: Member) => {
    setAuth({ status: "signed-in", member });
    navigate("/", { replace: true });
  };

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

  return <Home member={auth.member} onSignOut={onSignOut} />;
}
