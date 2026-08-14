'use client'

import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

/**
 * The mockup, at full viewport.
 *
 * onboarding-ux-spec.md: "Full screen = a full-screen modal, not a new tab.
 * The card's `View full screen` control opens the mockup in a full-viewport
 * dialog (stock shadcn Dialog stretched to the viewport) with a single close X
 * top-right. No stacking, no nested overlays, no custom animation — one dialog
 * component, used as-is. The user never leaves the page: open, look, close,
 * confirm."
 *
 * Stretched with className rather than by editing components/ui/dialog.tsx:
 * that file is what the CLI wrote and stays that way (onboarding ledger D1).
 *
 * THE SAME `src` AS THE CARD PREVIEW, and the same empty sandbox. One serving
 * route means the thing a friend inspects at full size is byte-identical to
 * the thing they were shown — a second source would be a promise made on their
 * behalf that nobody checked.
 *
 * Quiet double duty, from the spec: mockups are built against the fluid
 * container contract, and this dialog exercises it at confirmation time for
 * free — full viewport width on a desktop, phone width on a phone.
 */
export function MockupDialog({ version, title }: { version: number; title: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          View full screen
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="h-dvh w-screen max-w-none gap-0 rounded-none p-0 sm:max-w-none"
      >
        {/* Required for the dialog to be announced, and it names the thing
            being shown rather than the control that opened it. Visually
            hidden: the spec says one close X and nothing else. */}
        <DialogTitle className="sr-only">{`Preview of ${title}`}</DialogTitle>

        <DialogClose asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Close"
            className="absolute top-4 right-4 z-10"
          >
            <X />
          </Button>
        </DialogClose>

        <iframe
          title={`Preview of ${title}`}
          src={`/mockup/${version}`}
          sandbox=""
          className="h-full w-full border-0"
        />
      </DialogContent>
    </Dialog>
  )
}
