/**
 * ESLint rule: no-memory-payload-to-cloud
 *
 * Fails on any import specifier or property access that references the
 * user-data tables (`crystalMemories`, `crystalSessions`, `crystalMessages`,
 * `embedding`) inside files under `convex/cloud/**`.
 *
 * This enforces Principle 1 of the implementation plan:
 *   "Memories never leave the box. Cloud stores metadata + counts only."
 *
 * Rule message:
 *   "convex/cloud/** must never import crystalMemories — tenant memories live
 *    in local Convex only (Principle 1)."
 */

"use strict";

/** Table names (and related identifiers) that must never appear in cloud modules. */
const FORBIDDEN_IDENTIFIERS = [
  "crystalMemories",
  "crystalSessions",
  "crystalMessages",
  "embedding",
];

const MESSAGE =
  "convex/cloud/** must never import crystalMemories — tenant memories live in local Convex only (Principle 1).";

/**
 * Returns true when the file being linted lives under convex/cloud/.
 * Works with both Unix and Windows path separators.
 */
function isCloudFile(filename) {
  return /[/\\]convex[/\\]cloud[/\\]/.test(filename);
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "convex/cloud/** must never reference user-data tables (crystalMemories etc.)",
      recommended: true,
    },
    schema: [],
    messages: {
      forbidden: MESSAGE,
    },
  },

  create(context) {
    const filename = context.getFilename();
    if (!isCloudFile(filename)) {
      // Rule only applies inside convex/cloud/**
      return {};
    }

    return {
      // import { crystalMemories } from "..."
      // import * as foo from "../crystal/schema"  — caught via ImportDeclaration specifiers
      ImportDeclaration(node) {
        // Check the import source path for forbidden table names
        const source = node.source.value || "";
        for (const id of FORBIDDEN_IDENTIFIERS) {
          if (source.includes(id)) {
            context.report({ node, messageId: "forbidden" });
            return;
          }
        }

        // Check named import specifiers
        for (const specifier of node.specifiers) {
          const imported =
            specifier.type === "ImportSpecifier"
              ? specifier.imported?.name
              : null;
          if (imported && FORBIDDEN_IDENTIFIERS.includes(imported)) {
            context.report({ node: specifier, messageId: "forbidden" });
          }
        }
      },

      // Property access: schema.crystalMemories, api.crystal.crystalMemories, etc.
      MemberExpression(node) {
        const prop =
          node.property?.name ||
          (node.computed ? null : node.property?.value);
        if (prop && FORBIDDEN_IDENTIFIERS.includes(prop)) {
          context.report({ node, messageId: "forbidden" });
        }
      },

      // Identifier used standalone: crystalMemories (e.g. in a v.object() call)
      Identifier(node) {
        if (!FORBIDDEN_IDENTIFIERS.includes(node.name)) return;

        // Skip if this identifier is the property side of a MemberExpression
        // (already caught above) or is a key in an ObjectExpression — those
        // are non-reference uses.
        const parent = node.parent;
        if (
          parent?.type === "MemberExpression" &&
          parent.property === node &&
          !parent.computed
        ) {
          return; // already caught by MemberExpression visitor
        }
        if (
          parent?.type === "Property" &&
          parent.key === node &&
          !parent.computed
        ) {
          return; // object key — not a reference
        }
        if (parent?.type === "ImportSpecifier" && parent.imported === node) {
          return; // already caught by ImportDeclaration visitor
        }

        context.report({ node, messageId: "forbidden" });
      },
    };
  },
};
