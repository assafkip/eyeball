/* ═══════════════════════════════════════════════════════════════════════════
   eyeball — test/selftest.mjs : the negative self-test (the package's gate).

   A gate is not trusted until it has been SEEN to fail. This renders the committed
   fixtures through the real engine + assertions and proves eyeball:
     - is GREEN with ZERO violations on the clean page (defeats a gate that emits
       canned violations for everything), and
     - is RED on each defect class, tripping ONLY that defect's rule and none of
       the others (proves it discriminates per defect, not a blanket failure).
   It returns 2 (broken) if the engine/config cannot load or a fixture misbehaves,
   so a green self-test is never a rubber stamp.

   Run: `node test/selftest.mjs`  (also `eyeball --selftest`, `npm test`).
   ═══════════════════════════════════════════════════════════════════════════ */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");

// each bad fixture's distinctive violation token; good expects none of them.
const BAD = {
  "bad-fold": "first viewport",
  "bad-overlap": "pinned over the hero",
  "bad-draggable": "draggable centroid inside the hero",
  "bad-font": "banned face",
};

export async function selftest() {
  // load engine + config defensively: a missing/broken package or config is a
  // BROKEN self-test (exit 2), not a silent pass (Node would otherwise exit 1).
  let render, assertRender, CONFIG;
  try {
    ({ render } = await import("../src/render.mjs"));
    ({ assertRender } = await import("../src/assert.mjs"));
    CONFIG = JSON.parse(readFileSync(join(HERE, "..", "eyeball.config.example.json"), "utf8"));
  } catch (e) {
    console.log(`SELFTEST BROKEN: cannot load engine/config: ${e && e.message ? e.message : e}`);
    return 2;
  }

  const run = async (fixture) => assertRender(await render(join(FIX, `${fixture}.html`), CONFIG), CONFIG);
  const allTokens = Object.values(BAD);
  const problems = [];

  try {
    // 1) the clean page must produce ZERO violations (anti-canned guard).
    const good = await run("good");
    if (good.length) problems.push(`good.html should have ZERO violations but got: ${JSON.stringify(good)}`);

    // 2) each bad page must trip its OWN token and NONE of the others (isolation).
    for (const [name, token] of Object.entries(BAD)) {
      const v = await run(name);
      if (!v.some((x) => x.includes(token))) problems.push(`${name}.html should trip '${token}' but got: ${JSON.stringify(v)}`);
      for (const other of allTokens) {
        if (other !== token && v.some((x) => x.includes(other))) {
          problems.push(`${name}.html unexpectedly tripped '${other}' (not isolated): ${JSON.stringify(v)}`);
        }
      }
    }
  } catch (e) {
    console.log(`SELFTEST BROKEN: render failed: ${e && e.message ? e.message : e}`);
    return 2;
  }

  if (problems.length) {
    for (const p of problems) console.log("SELFTEST FAIL: " + p);
    return 2;
  }
  console.log("selftest OK: eyeball green (0 violations) on good; red on 4 isolated defect fixtures");
  return 0;
}

// run when invoked directly; catch any stray rejection so the contract holds (exit 2).
if (process.argv[1] && process.argv[1].endsWith("selftest.mjs")) {
  selftest().then((code) => process.exit(code)).catch((e) => {
    console.log("SELFTEST BROKEN: " + (e && e.message ? e.message : e));
    process.exit(2);
  });
}
