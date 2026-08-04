// Resolve the Convex function name from `convex run` argv after wrapper-local
// flags (e.g. --allow-local) have already been stripped.
//
// Fail closed: the first remaining argument must be the function name. Leading
// Convex options, option values, `--`, or ambiguous forms must never let a
// credential-returning function slip past classification by becoming args[N]
// while args[0] is an option token.

const FUNCTION_NAME =
  /^(?:[A-Za-z_][\w.-]*\/)*[A-Za-z_][\w.-]*:[A-Za-z_][\w]*$/;

/**
 * @param {string[]} args
 * @returns {string}
 */
export function resolveConvexRunFunctionName(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error(
      "usage: npm run convex:run -- <functionPath> ['<jsonArgs>'] [--allow-local]",
    );
  }

  const first = args[0];
  if (typeof first !== "string" || first.length === 0) {
    throw new Error(
      "Refusing convex run: function name is missing after wrapper flags.",
    );
  }
  if (first === "--" || first.startsWith("-")) {
    throw new Error(
      "Refusing convex run options before the function name. Pass the function path as the first argument (wrapper-local --allow-local is the only permitted leading flag).",
    );
  }
  if (!FUNCTION_NAME.test(first)) {
    throw new Error(
      `Refusing convex run: first argument is not a Convex function path (got ${JSON.stringify(first)}).`,
    );
  }

  // Defense in depth: a later token that looks like a credential function must
  // not be smuggled past classification via option value slots.
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token === "string" && FUNCTION_NAME.test(token) && token !== first) {
      throw new Error(
        "Refusing convex run: multiple function-path tokens are not allowed.",
      );
    }
  }

  return first;
}
