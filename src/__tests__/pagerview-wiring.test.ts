// Regression guards for the "PagerView onPageScroll is Object" Fabric crash.
//
// The bug: raw <PagerView> receiving a Reanimated useEvent worklet handler
// (an object, not a function) causes a runtime crash under the New Architecture:
//
//   "_this.props.onPageScroll is not a function (it is Object)"
//
// The fix: wrap PagerView with Animated.createAnimatedComponent so Reanimated
// registers the event handler natively and bypasses pager-view's JS wrapper.
//
// These are STATIC tests: they read Container.tsx as a string and assert
// structural properties that are hard to verify through the runtime mock
// (which swallows the error because the mocked PagerView is a plain div).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CONTAINER_SRC = readFileSync(
  resolve(__dirname, "../Container.tsx"),
  "utf8",
);

describe("PagerView wiring — Fabric crash regression guards", () => {
  it("declares AnimatedPagerView via Animated.createAnimatedComponent(PagerView)", () => {
    expect(CONTAINER_SRC).toMatch(
      /const\s+AnimatedPagerView\s*=\s*Animated\.createAnimatedComponent\(\s*PagerView\s*\)/,
    );
  });

  it("does not JSX-render raw <PagerView> (must use <AnimatedPagerView>)", () => {
    // Negative guard: any `<PagerView` JSX opening tag brings back the crash.
    // Negative lookbehind excludes `useRef<PagerView>` (type position, preceded
    // by a letter) while matching JSX positions (preceded by whitespace).
    const jsxOpens =
      CONTAINER_SRC.match(/(?<![A-Za-z0-9_])<PagerView[\s/>]/g) ?? [];
    expect(jsxOpens).toHaveLength(0);
    // Closing tag too — a stray </PagerView> implies a raw opener elsewhere.
    const jsxCloses = CONTAINER_SRC.match(/<\/PagerView>/g) ?? [];
    expect(jsxCloses).toHaveLength(0);
  });

  it("JSX-renders <AnimatedPagerView> with an onPageScroll prop", () => {
    expect(CONTAINER_SRC).toMatch(/<AnimatedPagerView\b/);
    // The tag closes with </AnimatedPagerView>
    expect(CONTAINER_SRC).toMatch(/<\/AnimatedPagerView>/);
    // onPageScroll prop is present inside the tag
    expect(CONTAINER_SRC).toMatch(/onPageScroll\s*=\s*{/);
  });

  it("imports Animated from react-native-reanimated (default import)", () => {
    expect(CONTAINER_SRC).toMatch(
      /import\s+Animated\s*(?:,\s*{[^}]*})?\s*from\s*['"]react-native-reanimated['"]/,
    );
  });

  it("uses useEvent for the onPageScroll worklet handler", () => {
    // The bug only appears when useEvent is involved — ensure it's still used
    expect(CONTAINER_SRC).toMatch(/useEvent\s*</);
  });
});
