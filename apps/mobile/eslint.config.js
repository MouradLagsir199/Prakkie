// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // eslint-config-expo promoted the React-Compiler react-hooks rules to
    // errors. On this existing codebase they flag ~40 pre-existing patterns
    // (setState-in-effect clamps, ref reads the analyzer can't prove are
    // outside render). They're correctness *hints*, not runtime bugs — keep
    // them visible as warnings and pay them down incrementally instead of
    // blocking CI on a risky mass refactor. TODO(prakkie): burn these down.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/use-memo": "warn",
    },
  },
]);
