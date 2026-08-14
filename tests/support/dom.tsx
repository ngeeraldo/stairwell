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
 * Make this environment one React 19 will treat `act` as authoritative in.
 *
 * One line, and it is load-bearing. Unflagged, React logs "The current testing
 * environment is not configured to support act(...)" and does not guarantee
 * that `act`'s promise has drained its work queue — so an assertion after an
 * awaited click can read pre-update DOM and pass for the wrong reason. That is
 * exactly the failure the tests using this file exist to prevent, so the
 * warning is treated as a defect rather than as noise.
 *
 * THIS FUNCTION USED TO CARRY A PILE OF RADIX SHIMS, and the plan for this
 * task said they were required: ResizeObserver, DOMRect, matchMedia, the
 * pointer-capture trio, scrollIntoView, HTMLDialogElement's methods. The
 * red-test drill disproved it. jsdom 29 really is missing all of them (probed
 * directly), but shadcn 4's Dialog, Tabs, Checkbox and Collapsible were each
 * rendered and clicked with none installed and none threw. Carrying stubs that
 * nothing needs, under a comment claiming they were load-bearing, would have
 * been worse than not having them: the next person to touch this file would
 * have believed the comment.
 *
 * If a future component genuinely needs one, add it back WITH the test that
 * goes red without it.
 */
export function installDomShims(): void {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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
