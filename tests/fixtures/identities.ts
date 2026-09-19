/**
 * Test-facing re-export of the demo identity data. The single source lives
 * in server/src/db/demo-identities.ts (the seed is runtime code — demo mode
 * is a real deployment mode, spec §8); this module keeps a stable import
 * path for tests and later-phase fixtures.
 */
export {
  DEMO_IDENTITIES,
  DEMO_PASSWORD,
} from "../../server/src/db/demo-identities.js";
export type {
  DemoId,
  DemoIdentity,
} from "../../server/src/db/demo-identities.js";
