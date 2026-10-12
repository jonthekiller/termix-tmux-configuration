/**
 * Post-build check / rewrite for the SDK import specifiers.
 *
 * The npm SDK keeps its own specifiers external, so the bundles ship bare
 * imports of `@termix-ssh/plugin-sdk/*`. Which bare names the shell resolves
 * depends on the Termix release:
 *
 *  - Termix 26.10+ maps `@termix-ssh/plugin-sdk/frontend|ui` (the npm name)
 *    and ships `node_modules/@termix-ssh/plugin-sdk` for the backend. This
 *    is the default target: nothing to rewrite, the check below fails the
 *    build if an OLD-name specifier is present (it would not resolve).
 *  - Termix 2.9.x maps `@termix/plugin-sdk/frontend|ui` instead and ships
 *    `node_modules/@termix/plugin-sdk`. Run `node scripts/postbuild.mjs
 *    --legacy` to rename the specifiers to those names.
 *
 * Without one instance of the SDK frontend shared with the shell, hooks such
 * as useHosts would throw "no plugin host".
 */

import { readFileSync, writeFileSync } from "node:fs";

const legacy = process.argv.includes("--legacy");
const HOST_NAME = legacy ? "@termix/plugin-sdk" : "@termix-ssh/plugin-sdk";
const OLD_NAME = legacy ? "@termix-ssh/plugin-sdk" : "@termix/plugin-sdk";

const SDK_SUBPATHS =
  /(frontend|ui|backend|db|manifest|settings|capabilities|ddl|table-builder)/g;

for (const file of ["dist/frontend.js", "dist/backend.js"]) {
  let text = readFileSync(file, "utf8");

  const stale = text.match(
    new RegExp(`["']${OLD_NAME.replace("@", "\\@")}/[a-z-]+["']`, "g"),
  );
  if (stale) {
    if (legacy) {
      text = text.replaceAll(
        new RegExp(`(["'])${OLD_NAME.replace("@", "\\@")}/`, "g"),
        `$1${HOST_NAME}/`,
      );
      console.log(
        `postbuild: renamed ${stale.length} legacy specifier(s) in ${file}`,
      );
    } else {
      console.error(
        `postbuild: ${file} still references "${OLD_NAME}/*", which ` +
          `Termix 26.10+ does not resolve (run with --legacy for Termix 2.9). ` +
          `Found: ${[...new Set(stale)].join(", ")}`,
      );
      process.exitCode = 1;
      continue;
    }
  }

  // The npm SDK name is the target; nothing to do unless a stray old name
  // slipped in. Write back only when a legacy rewrite happened.
  if (legacy) writeFileSync(file, text);
  console.log(
    `postbuild: ${file} targets ${HOST_NAME} (Termix ${legacy ? "2.9" : "26.10+"})`,
  );
}
