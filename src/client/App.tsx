import { CircleCheck, CircleX, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { HealthResponse } from "../shared/protocol";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type HealthState =
  | { status: "loading" }
  | { status: "ok"; health: HealthResponse }
  | { status: "error"; message: string };

export default function App() {
  const [state, setState] = useState<HealthState>({ status: "loading" });

  const check = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setState({ status: "ok", health: (await response.json()) as HealthResponse });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Colo</h1>
        <p className="text-muted-foreground">Shared notes for two. Skeleton build (M0).</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API health</CardTitle>
          <CardDescription>Worker → Workspace Durable Object</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={check} disabled={state.status === "loading"}>
              <RefreshCw data-icon="inline-start" />
              Check
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <HealthDetails state={state} />
        </CardContent>
      </Card>
    </main>
  );
}

function HealthDetails({ state }: { state: HealthState }) {
  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> Checking…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="flex items-center gap-2 text-destructive">
        <CircleX className="size-4" /> Unreachable: {state.message}
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-muted-foreground">Status</dt>
      <dd className="flex items-center gap-1.5">
        <CircleCheck className="size-4 text-emerald-600" /> OK
      </dd>
      <dt className="text-muted-foreground">Schema version</dt>
      <dd>{state.health.schemaVersion}</dd>
      <dt className="text-muted-foreground">Object location</dt>
      <dd>{state.health.colo ?? "unknown"}</dd>
    </dl>
  );
}
