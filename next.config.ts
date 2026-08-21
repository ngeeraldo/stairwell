import type { NextConfig } from 'next'

const config: NextConfig = {
  /**
   * Packages Next must NOT pull into its build graph.
   *
   * `better-sqlite3-multiple-ciphers` is here because it is a native module and
   * cannot be bundled at all.
   *
   * `plaid` is here because the SDK is generated from an OpenAPI spec and ships
   * `dist/api.js` as a SINGLE 9.2 MB module of 30,000 lines. Nothing in a
   * browser bundle may import it — it is reachable only from lib/plaid/*, which
   * only routes and scripts import — so parsing it into webpack's graph is pure
   * cost.
   *
   * IT IS NOT WHAT FIXED THE DROPLET'S OUT-OF-MEMORY BUILD, and this line said
   * that it was until the claim was tested. Externalising it changed nothing:
   * the heap went to TYPE CHECKING, which `serverExternalPackages` does not
   * affect at all — `next build` runs tsc, and `plaid/dist/api.d.ts` is another
   * 3.6 MB. The real fix is the build heap, in deploy/deploy.sh.
   */
  serverExternalPackages: ['better-sqlite3-multiple-ciphers', 'plaid'],
}

export default config
