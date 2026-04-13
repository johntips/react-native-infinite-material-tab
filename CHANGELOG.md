# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-04-13

### 🔴 Fixed — Non-integer scroll rest after swipe ("bleed-through")

Consumers with heavy first-mount content reported that the **first** swipe to
a not-yet-mounted tab sometimes left the native pager at a fractional scroll
offset (e.g. `2.3` or `3.7`) instead of snapping to the nearest integer page.
The tab indicator had already jumped to the target page via the `0.99`
threshold in `handlePageScrollHandler`, so the UI looked "settled", but the
viewport was still showing ~20–30% of a neighboring page on one side. Users
saw content, skeletons, or sold-out badges from an adjacent tab bleeding
into the current tab.

```
  Pager scroll offset = 3.7  (stuck between page 3 and page 4)

  ┌──────────────────────────────────┐
  │  ←─ page 3 (30%) ─→ │←─ page 4 (70%) ─→│
  │  neighboring tab    │   current tab     │
  │  bleed-through      │   ("パックがありません"│
  │                     │    or empty state) │
  └──────────────────────────────────┘
        indicator ↑ snapped to page 4 already
```

### Root cause

During the first-ever swipe to a tab, the JS thread is busy with children
mount, initial data-fetch subscriptions, and list layout (e.g. FlashList
measuring each cell). The UI thread's layout recomputation interferes with
the native pager's deceleration animation. `pagingEnabled` (iOS) /
`ViewPager2` (Android) normally snap to an integer page, but the snap can
abort early when a layout pass invalidates the viewport mid-decelerate.

**Subsequent swipes to the same tab don't reproduce** — the mount has
settled, there's no layout thrash, and the pager snaps cleanly.

### Why the example app didn't surface this

The example app used in local development and CI renders a trivial
`FlatList` of placeholder strings. First mount cost is <20 ms, layout is
stable, and the pager always has a clean deceleration window. Production
consumers shipping real apps — with rich list items, data-fetching hooks,
remote images, animation libraries, and nested providers — saturate the JS
thread during first mount and expose the bug.

The fix is now enforced at the library level so every consumer benefits
regardless of their children's mount cost.

### Fix: `lastPageFraction` + idle forced snap

A new `lastPageFraction` `SharedValue` tracks the fractional scroll position
(`position + offset`) every frame from inside the `onPageScroll` worklet.
When `handlePageScrollStateChanged` observes the transition to `idle` with
no pending edge-wrap jump, it reads the tracked fraction, rounds to the
nearest integer, and calls `pagerRef.current.setPageWithoutAnimation` when
the gap exceeds `0.01`. The tab indicator was already at the correct
integer, so the pager silently catches up without any visible animation.

- Tolerance is `0.01` — fractional reports from `onPageScroll` routinely
  land at `0.0000001` or `0.999999` due to float math. Below `0.01` is
  indistinguishable from a clean settle; above `0.01` reliably indicates a
  real mid-decelerate abort observed on both iOS simulators and physical
  devices.
- Bounds & NaN guards (`Number.isFinite`, `rounded >= 0`,
  `rounded < pages.length`) prevent the snap from firing before the first
  scroll event or with an out-of-range index.
- The `setPageWithoutAnimation` call is wrapped in `try/catch` mirroring
  the existing edge-wrap jump's pattern, so Android ViewPager2's "Scrapped
  or attached views may not be recycled" race is swallowed silently.

### How to keep libraries of this shape robust — design principles

This class of bug (native animation vs. JS-thread-heavy first mount) is
**inherently invisible to minimal example apps**. The library's robustness
against it has to be built in, not tested by hand. Guidelines applied in
this release and recommended for any PagerView / ScrollView-backed library:

1. **Defensive snap on every idle transition, not only "when we know it
   went wrong"**. The implementation does not try to detect "was the JS
   thread busy?" — it just always checks the fraction on idle. Zero cost
   when the native snap worked correctly (the fraction is already an
   integer so nothing happens), fully repairs the rare abort case.

2. **Device-size independent**. The snap compares a scroll *fraction*
   (dimensionless, bounded in `[0, N-1]`), never a pixel distance. Small
   phones and tablets both land in `[0, 0.01)` when settled cleanly, so
   the tolerance doesn't need device-specific tuning.

3. **Track the fraction inside the worklet, read it from JS**. `SharedValue`
   is the only correct crossing mechanism here — a React state or ref
   updated via `runOnJS` would be stale (post-settle). Writing from the
   `onPageScroll` worklet means the JS side always sees the most recent
   native position.

4. **Round, don't compute "intended direction"**. Trying to infer "the
   user wanted to go forward / back" from scroll velocity or gesture data
   is fragile across gesture systems. `Math.round` of the current fraction
   is correct because the native pager already decided how far to
   decelerate; we just complete what it couldn't finish due to JS thread
   interference.

5. **Match the existing `try/catch` / re-entrancy pattern**. The library
   already had one mid-idle jump (`pendingJumpIndexRef` edge-wrap) guarded
   against ViewPager2's recycle race. The forced snap reuses that exact
   shape so the two code paths can't diverge.

### Regression guards added

- **Unit test** (`src/__tests__/idle-forced-snap.test.ts`): static source
  scans verifying
  - `lastPageFraction` is declared as a `SharedValue(0)`
  - the `onPageScroll` worklet writes `position + offset` to it
  - the `idle` branch of `handlePageScrollStateChanged` reads the fraction,
    rounds it, compares against `> 0.01`, and calls
    `setPageWithoutAnimation(rounded)`
  - bounds (`Number.isFinite`, `rounded >= 0`, `rounded < pages.length`)
    and `try/catch` wrapping are present
- **Numeric edge-case suite** (`src/__tests__/forced-snap-logic.test.ts`):
  runtime tests of the rounding/tolerance logic extracted into a pure
  helper, covering:
  - clean settles (`0`, `2.0`, `5.0`, `0.0000001`, `4.999999`) → no snap
  - real aborts (`2.3`, `3.7`, `1.15`, `4.85`) → snap to the nearest page
  - invalid inputs (`NaN`, `Infinity`, `-1.2`, `>= pages.length`) → no snap
  - screen-size independence: the same fractions produce the same decisions
    on simulated 320px (small phone), 414px (regular phone), and 768px
    (tablet) page widths

### No breaking changes

The forced snap only activates when the pager rests off-integer; swipes
that already settle cleanly never trigger it. The public API is unchanged.

### Migration

```bash
pnpm add react-native-infinite-material-tab@0.2.2
cd ios && pod install
pnpm start -- --clear
```

## [0.2.1] - 2026-04-11

### 🔴 Fixed — Fabric crash: `onPageScroll is not a function (it is Object)`

Every consumer on **React Native New Architecture (Fabric)** hit a red-box on
the first page-scroll event:

```text
Uncaught Error
_this.props.onPageScroll is not a function (it is Object)
  PagerView.tsx:78:30
```

**Root cause**: `Container.tsx` passed the Reanimated `useEvent` worklet handler
(a _WorkletEventHandler object_, not a function) directly to a **raw** `<PagerView>`.
Under the New Architecture, `react-native-pager-view`'s JS-side `_onPageScroll`
wrapper calls `this.props.onPageScroll(e)` unconditionally — an object passed
through `as unknown as …` casts silently breaks at runtime.

**Fix**: wrap `PagerView` with `Animated.createAnimatedComponent(PagerView)`.
Reanimated then registers the worklet handler natively and the JS wrapper is
bypassed. The same pattern was already used in `FlatList.tsx` (`AnimatedFlatList`);
the PagerView wiring was the only holdout.

### Why Paper didn't catch it

The example app shipped without `newArchEnabled`, defaulting to Paper, where
the native event bridge routed `onPageScroll` to the worklet directly without
going through `ReactFabric-dev.js`'s JS dispatch path. The library therefore
never crashed in Paper but always crashed in Fabric.

### Regression guards added

- **Unit test** (`src/__tests__/pagerview-wiring.test.ts`): static source scan
  verifying `Container.tsx` uses `AnimatedPagerView`, never raw `<PagerView>`
- **example/app.json**: `newArchEnabled: true` — example app now runs Fabric,
  matching production consumers
- **New default CI job**: `build-example` runs `expo export:embed` (Metro bundle)
  on every push/PR — would have caught the missing `createAnimatedComponent`
  import at build time
- **Maestro E2E** moved to its own `workflow_dispatch`-only workflow
  (`.github/workflows/e2e.yml`) so the default CI stays fast, but the full
  device-level validation remains available on demand

### Migration

No API changes. Bump and rebuild:

```bash
pnpm add react-native-infinite-material-tab@0.2.1
# iOS
cd ios && pod install
# Restart Metro with cache clear
pnpm start -- --clear
```

---

## [0.2.0] - 2026-04-11

### 🎯 Performance — Critical lazy mount fix (`lazy={true}`)

**Fixed a severe bug where a single tab activation triggered up to `BUFFER_MULTIPLIER` (=10) parallel HeavyContent mounts.**

`lazy={true}` + infinite scroll で 1 タブあたり HeavyContent が 10 並列 mount される致命的な bug を修正。

- **Problem**: `Container` の `mountedIndexes` が **realIndex** をキーにしていたため、infinite scroll の virtual page 複製により同じ realIndex を持つ 10 個の virtual page が全て children を render していた。consumer が渡した heavy な children (FlashList, 大量の hooks, データ fetch など) が 10 インスタンス同時に mount され、JS thread を完全に詰まらせていた。

  The previous `mountedIndexes` Set was keyed by **realIndex**. With `BUFFER_MULTIPLIER=10` virtual pages per real tab, every virtual copy of a once-visited realIndex was rendering its children — meaning consumer-provided heavy children (FlashList, data fetching, dozens of hooks) were mounted up to 10 times in parallel, saturating the JS thread.

- **Fix**: `mountedIndexes` を `mountedPagerIndexes` に変更して **pagerIndex (virtual page index) をキーにして追跡**するように。`handlePageSelected` / `handleTabPress` から `addMountedPagerRange(pagerIndex)` で新規 pagerIndex を mount 集合に追加する。

  `mountedIndexes` is now `mountedPagerIndexes`, keyed by **pagerIndex (virtual page index)**. Only virtual pages the user actually reaches get their children rendered. `handlePageSelected` / `handleTabPress` call `addMountedPagerRange(pagerIndex)` to extend the mounted range as the user swipes.

### Measured impact

Measured on a 20-tab example with heavy child content (iPhone 16e, Maestro 10-swipe automation):

| Metric | Before (v0.1.1) | After (v0.2.0) | Improvement |
|--------|-----------------|----------------|-------------|
| JS dispatch latency | 400-750 ms 🔴 | **13-28 ms 🟢** | **~25x** |
| Mount cost per tab | ~500 ms × **10 instances** | **~50 ms × 1 instance** | **~100x** |
| Worklet→JS hop | 1000-1700 ms burst | **0 ms** (steady state) | **∞** |
| Total (swipe→content) | 3000-17000 ms | **600-900 ms** | **~5-20x** |

### Migration

- **Fully backwards compatible**. No API changes.
- `lazy={true}` consumers automatically benefit from the fix with no code changes required.

## [0.1.1] - 2026-04-10

### Performance

- Tab bar centering now runs entirely on the UI thread via `reanimatedScrollTo(useAnimatedRef)` inside `useAnimatedReaction`. Decouples the tab bar animation from any JS thread work (e.g., heavy list mounting).

## [0.1.0] - 2026-04-10

### Initial Release

Infinite scroll Material Design tab view for React Native, built on PagerView + Reanimated for native-grade performance.

### Features

- **Infinite horizontal scroll** — seamless loop via virtual index approach (10× buffer, no visible jumps)
- **Zero JS thread work during swipe gestures** — `activeIndex` is a Reanimated `SharedValue`, not React state
- **Worklet-driven tab indicator** — `useAnimatedReaction` + `withTiming` runs entirely on UI thread
- **Deferred JS state updates** — tab label color updates happen on next frame via `requestAnimationFrame`
- **Lazy mount support** — `lazy={true}` skips rendering of non-nearby tabs until first activation
- **Dynamic tab width** — auto-measured via `onLayout` with `requestAnimationFrame` batching
- **Collapsible header support** — scroll-linked header animation via `scrollY` SharedValue
- **FlashList / FlatList / ScrollView wrappers** — `Tabs.FlashList`, `Tabs.FlatList`, `Tabs.ScrollView`
- **Debug logging** — opt-in `debug` prop with app-side callback for tab lifecycle tracking
- **New Architecture (Fabric) ready**
- **Expo 55+ compatible**

### API

#### Components
- `Tabs.Container` — main container with header/tabs/content layout
- `Tabs.Tab` — tab declaration
- `Tabs.FlashList` / `Tabs.FlatList` / `Tabs.ScrollView` — scroll wrappers
- `MaterialTabBar` — customizable Material Design tab bar
- `DefaultTabBar` — minimal default tab bar

#### Hooks
- `useActiveTabIndex()` — returns `SharedValue<number>` (no re-render)
- `useActiveTabIndexValue()` — returns `number` (triggers re-render)
- `useNearbyIndexes()` — returns `SharedValue<number[]>`
- `useIsNearby(tabName)` — returns `boolean` for prefetch eligibility
- `useCurrentTabScrollY()` — returns scroll Y position
- `useTabs()` — returns tab array

### Architecture

```
PagerView swipe (native thread, 60fps)
  ↓
activeIndex.value = n (UI thread, 0ms)
  ↓
  ├── useAnimatedReaction → withTiming indicator (UI thread, zero JS)
  ├── useDerivedValue → nearbyIndexes (UI thread)
  └── Tab label color: rAF-deferred setState (next frame)
```

JS thread is never blocked by gesture handling. Heavy list content mounting is independent from tab swipe gestures.
