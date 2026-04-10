# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
