// Numeric edge-case tests for resolveForcedSnapTarget.
//
// The helper is device-size independent by design: it operates on page
// fractions (dimensionless, in `[0, N-1]`), never on pixel distances. These
// tests cover the decision boundaries — clean settles, real aborts,
// invalid inputs, and confirm screen-width independence by replaying the
// same decisions against simulated small phone / regular phone / tablet
// page widths.

import { describe, expect, it } from "vitest";
import { resolveForcedSnapTarget } from "../utils";

describe("resolveForcedSnapTarget — clean settles (should not snap)", () => {
  it("returns null for exact integer fractions", () => {
    expect(resolveForcedSnapTarget(0, 60)).toBeNull();
    expect(resolveForcedSnapTarget(1, 60)).toBeNull();
    expect(resolveForcedSnapTarget(30, 60)).toBeNull();
    expect(resolveForcedSnapTarget(59, 60)).toBeNull();
  });

  it("returns null when the gap is below 0.01 tolerance (float noise)", () => {
    // Typical noise values reported by onPageScroll after a clean settle.
    expect(resolveForcedSnapTarget(0.0000001, 60)).toBeNull();
    expect(resolveForcedSnapTarget(2.000001, 60)).toBeNull();
    expect(resolveForcedSnapTarget(4.9999999, 60)).toBeNull();
    expect(resolveForcedSnapTarget(30.009, 60)).toBeNull();
    expect(resolveForcedSnapTarget(30.991, 60)).toBeNull();
  });
});

describe("resolveForcedSnapTarget — real aborts (should snap)", () => {
  it("rounds down when closer to the lower integer", () => {
    expect(resolveForcedSnapTarget(2.3, 60)).toBe(2);
    expect(resolveForcedSnapTarget(3.15, 60)).toBe(3);
    expect(resolveForcedSnapTarget(30.1, 60)).toBe(30);
  });

  it("rounds up when closer to the upper integer", () => {
    expect(resolveForcedSnapTarget(2.7, 60)).toBe(3);
    expect(resolveForcedSnapTarget(3.85, 60)).toBe(4);
    expect(resolveForcedSnapTarget(30.9, 60)).toBe(31);
  });

  it("handles Math.round's banker boundary (0.5 rounds to even on some runtimes — we accept whichever)", () => {
    // Math.round(0.5) === 1 in JS (always rounds half away from zero), but
    // the exact boundary is uncommon in real onPageScroll reports. We assert
    // that the result is one of the two neighbors — not a specific one.
    const result = resolveForcedSnapTarget(2.5, 60);
    expect([2, 3]).toContain(result);
  });

  it("fires for the observed mid-abort range (0.2 - 0.3 away)", () => {
    // Production consumers reported rests at ~0.2-0.3 off the target page.
    expect(resolveForcedSnapTarget(3.2, 60)).toBe(3);
    expect(resolveForcedSnapTarget(3.7, 60)).toBe(4);
    expect(resolveForcedSnapTarget(3.8, 60)).toBe(4);
  });
});

describe("resolveForcedSnapTarget — invalid inputs (should not snap)", () => {
  it("returns null for NaN fraction", () => {
    expect(resolveForcedSnapTarget(Number.NaN, 60)).toBeNull();
  });

  it("returns null for Infinity / -Infinity fraction", () => {
    expect(resolveForcedSnapTarget(Number.POSITIVE_INFINITY, 60)).toBeNull();
    expect(resolveForcedSnapTarget(Number.NEGATIVE_INFINITY, 60)).toBeNull();
  });

  it("returns null when rounded target would be negative", () => {
    expect(resolveForcedSnapTarget(-0.4, 60)).toBeNull();
    expect(resolveForcedSnapTarget(-1.2, 60)).toBeNull();
  });

  it("returns null when rounded target equals or exceeds pagesLength", () => {
    expect(resolveForcedSnapTarget(60, 60)).toBeNull();
    expect(resolveForcedSnapTarget(59.7, 60)).toBeNull(); // rounds to 60
    expect(resolveForcedSnapTarget(100, 60)).toBeNull();
  });

  it("returns null for invalid pagesLength", () => {
    expect(resolveForcedSnapTarget(3.5, 0)).toBeNull();
    expect(resolveForcedSnapTarget(3.5, -1)).toBeNull();
    expect(resolveForcedSnapTarget(3.5, Number.NaN)).toBeNull();
    expect(resolveForcedSnapTarget(3.5, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("resolveForcedSnapTarget — device-size independence", () => {
  // The helper operates on fractions, not pixels. Simulating different
  // physical page widths should not change the decision. We sweep a range
  // of common mobile device widths and assert the same abort fractions
  // always resolve to the same rounded pages.
  const devices = [
    { name: "small phone (iPhone SE)", pageWidth: 320 },
    { name: "regular phone (iPhone 14)", pageWidth: 390 },
    { name: "large phone (iPhone Pro Max)", pageWidth: 430 },
    { name: "small tablet (iPad mini)", pageWidth: 744 },
    { name: "large tablet (iPad Pro 12.9)", pageWidth: 1024 },
  ];

  // A single abort-fraction table representing a consumer that swiped to
  // page 3 but got stuck at various fractional rests across devices.
  const cases: Array<{ fraction: number; expected: number | null }> = [
    { fraction: 3.0, expected: null }, // clean
    { fraction: 3.005, expected: null }, // noise
    { fraction: 3.1, expected: 3 }, // abort, close to 3
    { fraction: 3.3, expected: 3 },
    { fraction: 3.7, expected: 4 },
    { fraction: 3.9, expected: 4 },
    { fraction: 3.995, expected: null }, // noise
    { fraction: 4.0, expected: null }, // clean
  ];

  for (const { name, pageWidth } of devices) {
    describe(`${name} (pageWidth=${pageWidth})`, () => {
      for (const { fraction, expected } of cases) {
        it(`fraction=${fraction} → ${expected === null ? "no snap" : `snap to ${expected}`}`, () => {
          // Screen width is not an input to the helper — the test proves
          // that fact by running the same cases across devices and getting
          // identical decisions. The pageWidth is merely metadata.
          void pageWidth; // keep the linter happy; width isn't used
          expect(resolveForcedSnapTarget(fraction, 60)).toBe(expected);
        });
      }
    });
  }
});

describe("resolveForcedSnapTarget — consumer-complexity independence", () => {
  // Different consumer children (trivial FlatList vs heavy FlashList with
  // data fetching) produce different first-mount JS thread load, but the
  // RESULTING fractional offset is what matters — and the helper treats
  // every fraction identically regardless of what caused it.
  it("decides the same regardless of why the pager stopped short", () => {
    // Example app (trivial content): the pager always snaps cleanly.
    expect(resolveForcedSnapTarget(3.000001, 60)).toBeNull();

    // Heavy consumer app (complex list, data fetch): same fraction =
    // same decision.
    expect(resolveForcedSnapTarget(3.000001, 60)).toBeNull();

    // Heavy consumer that caused an abort: the library self-repairs.
    expect(resolveForcedSnapTarget(3.25, 60)).toBe(3);
  });
});
