import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import localRules from "eslint-plugin-local-rules";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/_generated/**",
      "**/convex_generated/**",
    ],
  },
  {
    files: ["convex/**/*.ts", "mcp-server/src/**/*.ts", "apps/web/**/*.ts", "apps/web/**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["convex/**/*.ts"],
    plugins: {
      "local-rules": localRules,
    },
    rules: {
      "local-rules/no-public-userid-arg": "error",
    },
  },
];
