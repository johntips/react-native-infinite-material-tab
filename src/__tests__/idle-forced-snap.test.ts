// Regression guards for the "non-integer offset rest" bug.
//
// The bug: when the JS thread is busy (first-time children mount, heavy
// data fetches, layout recomputation) during the native pager's deceleration
// animation, the pager can come to rest at a non-integer scroll fraction.
// The tab indicator snaps to the target page early via the 0.99 threshold
// in `handlePageScrollHandler`, but the PagerView itself stops ~0.2-0.3
// pages short. Result: the viewport shows the current page on one side and
// the neighboring page on the other — "bleed-through".
//
// The fix: track the latest fractional scroll position in a SharedValue
// during `onPageScroll`, and on idle, delegate to `resolveForcedSnapTarget`
// (pure helper in utils.ts) to decide whether to force-snap via
// `setPageWithoutAnimation`.
//
// These are STATIC tests: they read Container.tsx as a string and assert
// the presence of the tracker SharedValue and the snap wiring. The numeric
// logic of the resolver is covered by `forced-snap-logic.test.ts`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONTAINER_SRC = readFileSync(
  resolve(__dirname, "../Container.tsx"),
  "utf8",
);

describe("idle forced-snap — non-integer offset regression guards", () => {
  it("declares lastPageFraction SharedValue", () => {
    expect(CONTAINER_SRC).toMatch(
      /const\s+lastPageFraction\s*=\s*useSharedValue\s*\(\s*0\s*\)/,
    );
  });

  it("updates lastPageFraction inside the onPageScroll worklet", () => {
    // The worklet receives position and offset; the tracker must be written
    // with their sum so the idle-state handler can detect a fractional rest.
    expect(CONTAINER_SRC).toMatch(
      /lastPageFraction\.value\s*=\s*position\s*\+\s*offset/,
    );
  });

  it("imports and invokes resolveForcedSnapTarget from utils", () => {
    expect(CONTAINER_SRC).toMatch(
      /import\s*\{[^}]*resolveForcedSnapTarget[^}]*\}\s*from\s*"\.\/utils"/,
    );
    expect(CONTAINER_SRC).toMatch(
      /resolveForcedSnapTarget\(\s*fraction\s*,\s*pages\.length\s*\)/,
    );
  });

  it("forces snap via setPageWithoutAnimation when resolver returns non-null", () => {
    // Shape check: the idle branch must consult the resolver and call
    // setPageWithoutAnimation(rounded) only when it returns a concrete index.
    expect(CONTAINER_SRC).toMatch(/rounded\s*!==\s*null/);
    expect(CONTAINER_SRC).toMatch(
      /pagerRef\.current\?\.setPageWithoutAnimation\(\s*rounded\s*\)/,
    );
  });

  it("wraps the forced setPageWithoutAnimation in try/catch", () => {
    // ViewPager2 on Android throws "Scrapped or attached views may not be
    // recycled" during concurrent layout passes. Mirror the existing
    // edge-wrap jump's try/catch shape to keep the crash swallowed.
    const idleBlockRegex =
      /jumpIndex\s*===\s*null[\s\S]*?try\s*\{[\s\S]*?setPageWithoutAnimation\(\s*rounded\s*\)[\s\S]*?\}\s*catch/;
    expect(CONTAINER_SRC).toMatch(idleBlockRegex);
  });
});
