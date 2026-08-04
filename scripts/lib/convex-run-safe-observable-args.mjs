// Exact argv grammar for safe-observable AC count actions after wrapper-local
// flags (e.g. --allow-local) have already been stripped.
//
// Allowed:
//   <functionName>
//   <functionName> <jsonArgs>   where jsonArgs parses to exactly {}
//
// Rejected before deployment credential resolution / helper invocation:
//   nonempty objects, malformed JSON, second JSON positional, --component
//   (joined or separated), any unknown/trailing Convex option, any extra
//   positional. Never silently drop component intent and run the root action.

/**
 * @param {string[]} remainingArgs
 * @returns {Record<string, never>}
 */
export function parseSafeObservableArgs(remainingArgs) {
  if (!Array.isArray(remainingArgs) || remainingArgs.length === 0) {
    throw new Error(
      "Refusing safe-observable run: function name is required.",
    );
  }
  if (remainingArgs.length === 1) {
    return {};
  }
  if (remainingArgs.length > 2) {
    const extra = remainingArgs.slice(2);
    const joined = extra.join(" ");
    throw new Error(
      `Refusing safe-observable run: trailing arguments are not allowed (got ${JSON.stringify(joined)}). Pass only the function path, optionally with exact empty JSON args {}.`,
    );
  }

  const raw = remainingArgs[1];
  if (typeof raw !== "string") {
    throw new Error(
      "Refusing safe-observable run: expected a JSON object string or no args.",
    );
  }
  if (raw === "--" || raw.startsWith("-")) {
    throw new Error(
      `Refusing safe-observable run: Convex options are not allowed after the function name (got ${JSON.stringify(raw)}). Component-scoped and other convex run flags must not be silently ignored.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Refusing safe-observable run: function arguments must be exact empty JSON object {}.",
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 0
  ) {
    throw new Error(
      "Refusing safe-observable run: function arguments must be exact empty JSON object {}.",
    );
  }
  return {};
}
