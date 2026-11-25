// Plugin sources import each other without an extension: `claude plugin validate` type-checks a
// hooks module with fixed compiler options that reject a `.ts` import path. Node needs the
// extension, so the repo scripts that load plugin sources run with
//   node --import ./scripts/resolve-ts.ts <script>
// which retries an extensionless relative import as `.ts`.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
      if (!isRelative || /\.[cm]?[jt]sx?$/.test(specifier)) throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  },
})
