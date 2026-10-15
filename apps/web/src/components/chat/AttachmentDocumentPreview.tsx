import { ExternalLinkIcon, EyeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { t } from "~/i18n";

import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";

export type AttachmentDocumentKind = "html" | "pdf";

/** HTML and PDF attachments open in the in-app document preview; other files only download. */
export function attachmentDocumentKind(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): AttachmentDocumentKind | null {
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType === "application/pdf" || /\.pdf$/i.test(attachment.name)) return "pdf";
  if (mimeType === "text/html" || /\.html?$/i.test(attachment.name)) return "html";
  return null;
}

/**
 * A Preview button for one HTML or PDF attachment. `source` is the signed
 * asset URL of a sent attachment, or the local `Blob` of a staged one; a Blob
 * gets an object URL only while the dialog is open.
 */
export function AttachmentDocumentPreviewButton(props: {
  readonly name: string;
  readonly kind: AttachmentDocumentKind;
  readonly source: string | Blob;
  readonly className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={props.className}
        aria-label={t("preview", { name: props.name })}
        onClick={() => setOpen(true)}
      >
        <EyeIcon />
        {t("attachmentPreview.open")}
      </Button>
      {open ? (
        <AttachmentDocumentDialog
          name={props.name}
          kind={props.kind}
          source={props.source}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AttachmentDocumentDialog(props: {
  readonly name: string;
  readonly kind: AttachmentDocumentKind;
  readonly source: string | Blob;
  readonly onClose: () => void;
}) {
  const [src, setSrc] = useState(() => (typeof props.source === "string" ? props.source : null));
  useEffect(() => {
    if (typeof props.source === "string") {
      setSrc(props.source);
      return;
    }
    const url = URL.createObjectURL(props.source);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [props.source]);

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        className="flex h-[85vh] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        bottomStickOnMobile={false}
      >
        <DialogHeader className="flex-row items-center gap-2 border-b px-4 py-3 pe-12">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">{props.name}</DialogTitle>
          {src ? (
            <Button
              size="xs"
              variant="ghost"
              render={<a href={src} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon />
              {t("attachmentPreview.openInNewTab")}
            </Button>
          ) : null}
        </DialogHeader>
        {src === null ? null : props.kind === "html" ? (
          <iframe
            key={src}
            src={src}
            title={props.name}
            className="min-h-0 w-full flex-1 border-0 bg-white"
            // Scripts run in an opaque origin, isolated from the app session and parent page.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        ) : (
          // oxlint-disable-next-line react/iframe-missing-sandbox -- the browser's PDF viewer needs an unsandboxed frame; a PDF runs no page scripts.
          <iframe
            key={src}
            src={`${src}#toolbar=0&view=FitH`}
            title={props.name}
            className="min-h-0 w-full flex-1 border-0 bg-white"
            referrerPolicy="no-referrer"
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
