// Correctness, not formatting. Every rule here either catches a bug or refuses a construct this
// project has decided against; none of them rewrite whitespace. The formatting in this repository
// is deliberate in places, and a tool that reformatted it would bury the next real change in noise.
//
// The rules below are the ones the codebase already satisfies, so the file is a ratchet: it locks
// in what is true today and fails the build on the day it stops being true. The handful of rules
// deliberately left off are named at the bottom, with the reason.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", ".wrangler/", "scripts/out/", "public/app/version.json"],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Tightenings of what `recommended` already covers.
      "no-unused-vars": ["error", { args: "after-used", caughtErrors: "none", ignoreRestSiblings: true }],
      "no-constant-condition": ["error", { checkLoops: false }],

      // Bugs that `recommended` does not catch.
      "array-callback-return": "error",
      "no-constructor-return": "error",
      "no-duplicate-imports": "error",
      "no-promise-executor-return": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",

      // Constructs this project does not use, kept out before they arrive.
      "no-caller": "error",
      "no-eval": "error",
      "no-extend-native": "error",
      "no-implied-eval": "error",
      "no-iterator": "error",
      "no-labels": "error",
      "no-lone-blocks": "error",
      "no-multi-str": "error",
      "no-new-func": "error",
      "no-new-wrappers": "error",
      "no-object-constructor": "error",
      "no-octal-escape": "error",
      "no-proto": "error",
      "no-script-url": "error",
      "no-sequences": "error",
      "no-unused-expressions": "error",

      // Idiom, where the codebase is already consistent.
      "default-case-last": "error",
      "dot-notation": "error",
      // "smart" allows `== null` to mean "null or undefined", which this code uses on purpose.
      "eqeqeq": ["error", "smart"],
      "guard-for-in": "error",
      "no-else-return": "error",
      "no-lonely-if": "error",
      "no-return-assign": "error",
      "no-throw-literal": "error",
      "no-undef-init": "error",
      "no-useless-call": "error",
      "no-useless-computed-key": "error",
      "no-useless-rename": "error",
      "no-var": "error",
      "operator-assignment": "error",
      "prefer-const": "error",
      "prefer-numeric-literals": "error",
      "prefer-object-spread": "error",
      "prefer-promise-reject-errors": "error",
      "prefer-regex-literals": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "radix": "error",
      "symbol-description": "error",
      "yoda": "error",

      // Off on purpose, each for a reason rather than for the noise:
      //
      // no-await-in-loop      An await in a loop is usually a mistake; here it is usually the point.
      //                       D1 work is sequential and the alternative is a batch that hides which
      //                       statement failed.
      // require-atomic-updates False on every request handler that reads, awaits, then writes.
      // no-console            The Worker logs unhandled errors on purpose; that log is the only
      //                       trace a failed request leaves.
      // no-nested-ternary     36 sites. The nesting is how the interface strings pick a case, and
      //                       unrolling it into `if` would be longer and no clearer.
      // no-useless-concat     `"https:" + "//"` in person-form.js is deliberate: verify.sh flags the
      //                       contiguous literal as an external reference.
      // no-useless-return     app.js returns early in `try` to mirror the same guard in `catch`.
      //                       Symmetry worth more than the saved line.
      "no-await-in-loop": "off",
      "require-atomic-updates": "off",
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.js", "vitest.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
];
