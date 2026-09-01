import type { LocalPluginFailure, LocalPluginFailureJournal } from "./localPluginFailureJournal";

export type IsolatedLocalPluginResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: LocalPluginFailure };

export async function runIsolatedLocalPluginContribution<A>(input: {
  readonly failures: LocalPluginFailureJournal;
  readonly pluginId: string;
  readonly contributionKind: string;
  readonly contributionId: string;
  readonly phase?: "invoke" | "render";
  readonly run: () => A | Promise<A>;
}): Promise<IsolatedLocalPluginResult<A>> {
  const phase = input.phase ?? "invoke";
  try {
    return { ok: true, value: await input.run() };
  } catch (error) {
    return {
      ok: false,
      failure: input.failures.record({
        pluginId: input.pluginId,
        phase,
        code: phase === "render" ? "contribution-render-failed" : "contribution-invoke-failed",
        contributionKind: input.contributionKind,
        contributionId: input.contributionId,
        error,
      }),
    };
  }
}
