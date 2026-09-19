"use client";

import { useEffect, useRef } from "react";
import { IconClose } from "./icons";

/**
 * A dialog built on the native <dialog> element, which brings focus trapping,
 * Escape-to-close, inertness of the page behind it and the top layer for free.
 * A div would have to reimplement all of it, badly.
 */
export function Modal({
  open, title, subtitle, onClose, children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // A click landing on the dialog itself rather than its contents is a
      // click on the backdrop.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      // Geometry only. Centring comes from the `dialog { margin: auto }` rule in
      // globals.css, which undoes Tailwind Preflight's `margin: 0` on `*`.
      className="panel fixed inset-0 h-fit rounded-lg p-0 w-[min(56rem,92vw)] max-h-[85vh] backdrop:bg-black/40 text-inherit"
    >
      <div className="flex items-start justify-between gap-4 px-5 py-3.5 border-b hairline">
        <div className="min-w-0">
          <h2 className="font-medium">{title}</h2>
          {subtitle && <p className="muted text-sm mt-0.5">{subtitle}</p>}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="muted rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
        >
          <IconClose className="w-4 h-4" />
        </button>
      </div>
      <div className="px-5 py-4 overflow-auto max-h-[calc(85vh-4.5rem)]">{children}</div>
    </dialog>
  );
}
