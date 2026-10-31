import globals from "globals";
import tseslint from "typescript-eslint";

const runtimeGlobals = {
  ...globals.browser,
  ...globals.node,
};

const jsLanguageOptions = {
  ecmaVersion: "latest",
  sourceType: "module",
  globals: runtimeGlobals,
};

const tsLanguageOptions = {
  parser: tseslint.parser,
  globals: runtimeGlobals,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
};

const commonIgnores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.reflectworld-state/**",
  "internal/**",
  "internal-notes/**",
  "storage/**",
  "packages/cam/bin/**",
  "packages/reflectworld/publish/**",
  "packages/reflectworld/bundled-monitor/**",
  "packages/reflectworld/bundled-dashboard/**",
  "eval/fixtures/**",
  "tests/fixtures/**",
  "_reference/**",
];

export default [
  {
    ignores: commonIgnores,
  },
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: jsLanguageOptions,
    rules: {
      "no-empty": ["warn", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: tsLanguageOptions,
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-empty": ["warn", { allowEmptyCatch: false }],
    },
  },
  {
    files: [
      "packages/*/index.ts",
      "packages/cam/src/**/*.{ts,tsx}",
      "packages/mem/src/**/*.{ts,tsx}",
      "packages/percept/src/**/*.{ts,tsx}",
      "packages/reflectworld/src/**/*.{ts,tsx}",
      "packages/shared/src/**/*.{ts,tsx}",
    ],
    ignores: [
      "**/__tests__/**",
      "packages/percept/src/bin/**",
      "packages/reflectworld/src/cli/**",
      "packages/reflectworld/src/installer/**",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "error",
    },
  },
];
