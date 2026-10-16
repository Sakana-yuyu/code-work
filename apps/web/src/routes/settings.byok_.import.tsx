import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ProviderImportConfirmDialog } from "../components/settings/ProviderImportConfirmDialog";
import {
  consumeProviderImportRequest,
  openProviderImportFragment,
  subscribeProviderImportRequests,
  type ProviderImportRequest,
} from "../lib/providerImportLink";

export const Route = createFileRoute("/settings/byok_/import")({
  component: ProviderImportRouteView,
});

const readInitialRequest = (): ProviderImportRequest | null => {
  const pending = consumeProviderImportRequest();
  if (pending !== null) return pending;
  // The hosted-page variant carries the fields after `#`, which the browser
  // never sends to the origin; strip it once read so the key does not
  // linger in the address bar.
  const hash = window.location.hash;
  if (hash.length <= 1 || !/\burl=/.test(hash)) return null;
  const imported = openProviderImportFragment(hash);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return imported;
};

function ProviderImportRouteView() {
  const navigate = useNavigate();
  const [request, setRequest] = useState<ProviderImportRequest | null>(readInitialRequest);

  useEffect(() => subscribeProviderImportRequests(setRequest), []);

  useEffect(() => {
    if (request === null) {
      void navigate({ to: "/settings/byok" });
    }
  }, [navigate, request]);

  return (
    <ProviderImportConfirmDialog
      request={request}
      onClose={() => void navigate({ to: "/settings/byok" })}
    />
  );
}
