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
  try {
    return { ok: true, value: await input.run() };
  } catch (error) {
    return {
      ok: false,
      failure: input.failures.record({
        pluginId: input.pluginId,
        phase: input.phase ?? "invoke",
        contributionKind: input.contributionKind,
        contributionId: input.contributionId,
        error,
      }),
    };
  }
}
