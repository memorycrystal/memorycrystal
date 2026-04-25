// Flags any exported Convex query/mutation/action whose args validator
// contains a field named "userId" — only internalQuery/internalMutation/internalAction may accept it.
module.exports = {
  meta: {
    type: "problem",
    docs: { description: "Public Convex functions must not accept a userId argument" },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee?.name;
        const isPublic = ["query", "mutation", "action"].includes(callee);
        if (!isPublic) return;
        const argsObj = node.arguments?.[0];
        if (!argsObj || argsObj.type !== "ObjectExpression") return;
        const argsProp = argsObj.properties?.find((p) => p.key?.name === "args");
        if (!argsProp) return;
        // Look for userId field in args validator
        const argsValue = argsProp.value;
        if (argsValue?.type === "CallExpression") {
          // v.object({ userId: ... })
          const fields = argsValue.arguments?.[0]?.properties ?? [];
          for (const field of fields) {
            if (field.key?.name === "userId") {
              context.report({
                node: field,
                message:
                  "Public Convex functions must not accept a userId argument. Use ctx.auth.getUserIdentity() instead.",
              });
            }
          }
        }
      },
    };
  },
};
