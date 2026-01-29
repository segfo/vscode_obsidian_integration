import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
      globals: {
        document: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Buffer: "readonly",
        MutationObserver: "readonly",
        HTMLElement: "readonly",
        BigInt: "readonly",
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["Cursor"] }],
    },
  },
]);
