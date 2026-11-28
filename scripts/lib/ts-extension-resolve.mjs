/**
 * Resolve extensionless relative imports to `.ts` for Node's type stripper.
 * Used only by scripts that import Convex TypeScript modules.
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../"))
    && !/\.(?:ts|js|mjs|cjs|json|node)$/.test(specifier)
  ) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // Fall through to the default resolver.
    }
  }
  return nextResolve(specifier, context);
}
