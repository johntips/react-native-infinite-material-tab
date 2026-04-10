# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
