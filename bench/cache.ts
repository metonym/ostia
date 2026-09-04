import {
  computeCacheKey,
  computeInputsDigest,
} from "../src/cache/fingerprint.ts"
import { group, task } from "../src/index.ts"

group("cache", () => {
  task("computeCacheKey", () =>
    computeCacheKey({
      workloadId: "wl_dogfood",
      phase: "timing",
      configFingerprint: "cfg_dogfood",
      bunVersion: Bun.version,
      toolVersion: "0.1.0",
      instrumented: false,
      inputsDigest: "digest_placeholder",
    }),
  )

  task("computeInputsDigest (src/**/*.ts, real files on disk)", () =>
    computeInputsDigest(["src/**/*.ts"]),
  )
})
