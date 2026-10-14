import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@codework/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

/**
 * Catalog-withdrawal convergence for the composer model picker. The session
 * catalog can change while the picker popover is open (a `session.models.updated`
 * activity rewrites `providerStatuses` upstream), so both renders below replay
 * the before/after props through the real component tree — the assertions pin
 * down that the rendered output follows the latest catalog instead of holding
 * on to the withdrawn selection.
 */

function providerSnapshot(input: {
  instanceId: string;
  driver: string;
  displayName: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    displayName: input.displayName,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  } as ServerProvider;
}

const codexId = ProviderInstanceId.make("codex");
const ghostId = ProviderInstanceId.make("ghostInstance");

const codexEntry = deriveProviderInstanceEntries([
  providerSnapshot({ instanceId: "codex", driver: "codex", displayName: "Codex" }),
])[0]!;
const claudeEntry = deriveProviderInstanceEntries([
  providerSnapshot({ instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude" }),
])[0]!;

const codexOptions: ReadonlyArray<ModelEsque> = [
  { slug: "gpt-5.4", name: "GPT-5.4 Codex" },
  { slug: "withdrawn-prime", name: "Withdrawn Prime" },
];

function renderPickerTrigger(model: string, options: ReadonlyArray<ModelEsque>): string {
  return renderToStaticMarkup(
    <ProviderModelPicker
      activeInstanceId={codexId}
      model={model}
      lockedProvider={null}
      instanceEntries={[codexEntry]}
      modelOptionsByInstance={new Map([[codexId, options]])}
      onInstanceModelChange={() => {}}
    />,
  );
}

function renderPickerContent(input: {
  activeInstanceId?: ProviderInstanceId;
  entries?: ReadonlyArray<typeof codexEntry>;
  options?: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}): string {
  return renderToStaticMarkup(
    <ModelPickerContent
      activeInstanceId={input.activeInstanceId ?? codexId}
      model="gpt-5.4"
      lockedProvider={null}
      instanceEntries={input.entries ?? [codexEntry]}
      modelOptionsByInstance={input.options ?? new Map([[codexId, codexOptions]])}
      terminalOpen={false}
      onInstanceModelChange={() => {}}
    />,
  );
}

describe("ProviderModelPicker catalog withdrawal convergence", () => {
  it("shows the selected model on the trigger while it stays in the catalog", () => {
    const html = renderPickerTrigger("withdrawn-prime", codexOptions);
    expect(html).toContain("Withdrawn Prime");
  });

  it("heals the trigger to the instance's first option when the selected model is withdrawn", () => {
    // Composer prop `model` still carries the withdrawn slug until the
    // selection state itself heals; the trigger must not display it.
    const remaining = codexOptions.filter((option) => option.slug !== "withdrawn-prime");
    const html = renderPickerTrigger("withdrawn-prime", remaining);
    expect(html).toContain("GPT-5.4 Codex");
    expect(html).not.toContain("Withdrawn Prime");
  });

  it("keeps the pending selection verbatim when the whole catalog is withdrawn", () => {
    // An explicitly emptied catalog leaves nothing to heal against; the
    // trigger falls back to the raw selection instead of fabricating a model.
    const html = renderPickerTrigger("withdrawn-prime", []);
    expect(html).toContain("withdrawn-prime");
  });

  it("drops a withdrawn instance's rail while the picker is open", () => {
    const before = renderPickerContent({ entries: [codexEntry, claudeEntry] });
    expect(before).toContain('data-model-picker-provider="codex"');
    expect(before).toContain('data-model-picker-provider="claudeAgent"');

    const after = renderPickerContent({ entries: [codexEntry] });
    expect(after).toContain('data-model-picker-provider="codex"');
    expect(after).not.toContain('data-model-picker-provider="claudeAgent"');
  });

  it("still renders when the viewed instance vanished from the entries", () => {
    // `selectedInstanceId` is picker-local state initialized from
    // `activeInstanceId`; a withdrawal that removes that instance mid-open
    // leaves the filter pointing at a gone id — the picker converges to an
    // empty list instead of throwing.
    const html = renderPickerContent({
      activeInstanceId: ghostId,
      entries: [codexEntry],
      options: new Map([[codexId, codexOptions]]),
    });
    expect(html).toContain('data-model-picker-provider="codex"');
  });
});
