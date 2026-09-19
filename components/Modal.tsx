"use client";

import { useEffect, useRef } from "react";
import { IconClose } from "./icons";

/** Shared across every Modal, so nested or overlapping dialogs unlock once. */
let lockCount = 0;
let previousOverflow = "";
let previousPadding = "";

/**
 * A dialog built on the native <dialog> element, which brings focus trapping,
 * Escape-to-close, inertness of the page behind it and the top layer for free.
 * A div would have to reimplement all of it, badly.
 */
export function Modal({
  open, title, subtitle, onClose, children, fill = false,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * Hold a fixed height instead of growing with the content, and hand the body
   * the remaining space to manage. For a panel whose content varies from three
   * rows to three hundred, a dialog that resizes under you is worse than one
   * that stays put and scrolls inside.
   */
  fill?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  /**
   * Stop the page behind scrolling.
   *
   * showModal() makes the rest of the document inert, which blocks clicks and
   * focus but not the scroll wheel, so the content behind still slides around
   * under the dialog. Locking the root is the only way to hold it still.
   *
   * Removing the scrollbar frees up its width and the page jumps; the padding
   * puts that width back. Counted rather than set outright, so one modal
   * closing cannot unlock the page while another is still open.
   */
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const gap = window.innerWidth - root.clientWidth;

    if (lockCount === 0) {
      previousOverflow = root.style.overflow;
      previousPadding = root.style.paddingRight;
      root.style.overflow = "hidden";
      if (gap > 0) root.style.paddingRight = `${gap}px`;
    }
    lockCount++;

    return () => {
      lockCount--;
      if (lockCount === 0) {
        root.style.overflow = previousOverflow;
        root.style.paddingRight = previousPadding;
      }
    };
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
      className={`panel fixed inset-0 rounded-lg p-0 w-[min(56rem,92vw)] backdrop:bg-black/40 text-inherit ${
        fill ? "flex flex-col h-[85vh]" : "h-fit max-h-[85vh]"
      }`}
    >
      <div className="flex items-start justify-between gap-4 px-5 py-3.5 border-b hairline shrink-0">
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
      {/*
        * Mount contents only while open. A closed <dialog> is display:none, and
        * anything that measures itself on mount, CodeMirror included, reads a
        * zero-width viewport there and comes back mis-scrolled when shown.
        */}
      <div
        className={
          fill
            ? "flex-1 min-h-0 flex flex-col px-5 py-4"
            : "px-5 py-4 overflow-auto max-h-[calc(85vh-4.5rem)]"
        }
      >
        {open && children}
      </div>
    </dialog>
  );
}
