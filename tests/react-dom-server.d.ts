// tests/react-dom-server.d.ts
//
// react-dom ships no bundled type declarations, and @types/react-dom isn't
// installed — CLAUDE.md forbids new npm dependencies, so this is a local
// ambient shim for the one export tests/chat/panel.test.ts needs:
// renderToStaticMarkup, used to fully expand a hook-free component tree
// (e.g. ProposalRegion nesting SpecCard) into real, escaped HTML for
// assertions, the same technique the security review already used and
// trusted to check sandbox escaping.
declare module 'react-dom/server' {
  import type { ReactNode } from 'react'
  export function renderToStaticMarkup(node: ReactNode): string
}
