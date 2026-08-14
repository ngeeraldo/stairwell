// tests/support/dom.tsx
//
// The smallest thing that can drive a React client component in jsdom.
//
// NOT @testing-library/react: the onboarding spec asked for jsdom and nothing
// else, and step-4 ledger residual 1 is the standing bar on new test
// dependencies (onboarding ledger D9). Everything below is react-dom/client
// plus React 19's own `act` — no query DSL, no matchers to learn.
//
// Every export is async and awaited, because `act` flushes effects and state
// updates on its returned promise. A test that forgets the await sees the
// pre-update DOM and passes for the wrong reason.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * What jsdom does not implement and Radix expects.
 *
 * shadcn's Dialog, Tabs, Checkbox and Collapsible are Radix underneath
 * (onboarding ledger D1), and Radix reaches for browser APIs jsdom has never
 * had. Each stub below exists because its absence THROWS rather than degrades
 * — so they are installed once, here, rather than rediscovered one component
 * at a time.
 *
 * They are STUBS, not implementations. Nothing in this suite asserts on
 * layout, and nothing here should ever grow into a fake layout engine: a
 * ResizeObserver that reported plausible sizes would let a test claim
 * something about arrangement that only a browser can actually settle. That
 * is what the Playwright review (onboarding ledger D16) is for.
 */
export function installDomShims(): void {
  // React 19 refuses to treat `act` as authoritative without this flag, and
  // says so on stderr: "The current testing environment is not configured to
  // support act(...)". It is not cosmetic — unflagged, React does not
  // guarantee that `act`'s promise has drained its work queue, so an assertion
  // after an awaited click can read pre-update DOM and pass for the wrong
  // reason. That is precisely the failure this whole file exists to prevent,
  // so the warning is treated as a defect rather than as noise.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver
  }

  if (!globalThis.DOMRect) {
    globalThis.DOMRect = class {
      top = 0
      right = 0
      bottom = 0
      left = 0
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0,
      ) {}
      toJSON(): object {
        return {}
      }
    } as unknown as typeof DOMRect
  }

  if (typeof window !== 'undefined' && !window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
      addListener() {},
      removeListener() {},
    })) as unknown as typeof window.matchMedia
  }

  const element = Element.prototype as unknown as Record<string, unknown>
  element.hasPointerCapture ??= () => false
  element.setPointerCapture ??= () => {}
  element.releasePointerCapture ??= () => {}
  element.scrollIntoView ??= () => {}

  // jsdom parses <dialog> but implements neither method. Radix's Dialog does
  // not use the native element, so this is only for anything that does.
  const dialog =
    typeof HTMLDialogElement === 'undefined'
      ? undefined
      : (HTMLDialogElement.prototype as unknown as Record<string, unknown>)
  if (dialog) {
    dialog.showModal ??= function (this: HTMLDialogElement) {
      this.open = true
    }
    dialog.close ??= function (this: HTMLDialogElement) {
      this.open = false
    }
  }
}

export type Mounted = { container: HTMLElement; unmount: () => Promise<void> }

/**
 * Render into a fresh container attached to document.body.
 *
 * Attached, not detached: Radix portals its overlays onto document.body, and
 * focus management only behaves if the tree is in the document. A test
 * asserting on a dialog's contents therefore queries `document.body`, not the
 * returned `container` — see tests/ui/primitives.test.tsx.
 */
export async function mount(element: React.ReactNode): Promise<Mounted> {
  installDomShims()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(element)
  })
  return {
    container,
    unmount: async () => {
      await act(async () => root?.unmount())
      container.remove()
    },
  }
}

/** Click, then let every resulting state update and effect settle. */
export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('click(): no element')
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/**
 * Set a controlled input's value the way a user typing would.
 *
 * React installs its own value setter on the instance, so assigning `.value`
 * directly updates the DOM without React ever hearing about it. Calling the
 * PROTOTYPE's setter is what makes the subsequent `input` event carry a value
 * React sees as changed.
 */
export async function type(el: Element | null | undefined, value: string): Promise<void> {
  if (!el) throw new Error('type(): no element')
  const node = el as HTMLInputElement | HTMLTextAreaElement
  const proto =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value)
  await act(async () => {
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Let pending promises and their state updates settle. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}
