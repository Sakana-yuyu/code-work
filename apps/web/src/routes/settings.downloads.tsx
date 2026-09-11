import { createFileRoute } from "@tanstack/react-router";

import { VersionDownloadsPanel } from "../components/settings/VersionDownloadsPanel";

export const Route = createFileRoute("/settings/downloads")({
  component: VersionDownloadsPanel,
});
