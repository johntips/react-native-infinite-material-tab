import type React from "react";
import type { ComponentProps } from "react";
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  InteractionManager,
  Platform,
  type ScrollView as RNScrollView,
  StyleSheet,
  View,
} from "react-native";
import type {
  PagerViewOnPageScrollEventData,
  PagerViewOnPageSelectedEvent,
} from "react-native-pager-view";
import PagerView from "react-native-pager-view";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useEvent,
  useSharedValue,
} from "react-native-reanimated";
import { TabsProvider } from "./Context";
import { SCREEN_WIDTH, TAB_BAR_HEIGHT } from "./constants";
import { DefaultTabBar } from "./TabBar";
import type { DebugLogEvent, TabsContainerProps } from "./types";
import { resolveForcedSnapTarget } from "./utils";

// react-native-pager-view v8 の JS 側 `_onPageScroll` wrapper は
// `this.props.onPageScroll(e)` を関数呼び出しするため、Reanimated の
// `useEvent` が返す worklet handler (object) をそのまま渡すと Fabric (新アーキ)
// 上で "_this.props.onPageScroll is not a function (it is Object)" として crash する。
//
// Animated.createAnimatedComponent でラップすると Reanimated がネイティブ側で
// 直接イベント登録を行い、JS 側の wrapper は一切呼ばれないので安全。
const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

interface VirtualPage {
  /** 実タブのインデックス (0..tabs.length-1) */
  realIndex: number;
  /** クローンかどうか */
  isClone: boolean;
}

export const Container: React.FC<TabsContainerProps> = ({
  children,
  renderHeader,
  renderTabBar,
  headerHeight = 0,
  infiniteScroll = true,
  tabBarCenterActive = true,
  onTabChange,
  onFocusedTabPress,
  containerStyle,
  headerContainerStyle,
  tabBarContainerStyle,
  allowHeaderOverscroll: _allowHeaderOverscroll = false,
  offscreenPageLimit = 1,
  lazy = false,
  debug = false,
  onDebugLog,
}) => {
  // デバッグログ: production ではデフォルト off、オプトインで有効化
  const debugLog = useCallback(
    (event: Omit<DebugLogEvent, "timestamp">) => {
      if (!debug) return;
      const fullEvent: DebugLogEvent = { ...event, timestamp: Date.now() };
      if (__DEV__) {
        console.log(
          `[rn-infinite-tab-view] ${event.type} | ${event.tabName} (idx:${event.tabIndex})${event.detail ? ` | ${event.detail}` : ""}`,
        );
      }
      onDebugLog?.(fullEvent);
    },
    [debug, onDebugLog],
  );
  // タブデータを子要素から抽出
  const tabs = useMemo(() => {
    const tabList: Array<{ name: string; label: string }> = [];
    Children.forEach(children, (child) => {
      if (
        isValidElement<{ name: string; label: string }>(child) &&
        child.props.name &&
        child.props.label
      ) {
        tabList.push({
          name: child.props.name,
          label: child.props.label,
        });
      }
    });
    return tabList;
  }, [children]);

  // activeIndex を SharedValue 化 — re-render なしで UI thread に値を伝播
  const activeIndex = useSharedValue(0);
  const prevActiveIndexRef = useRef(0);
  const tabScrollRef = useRef<RNScrollView>(null);

  // PagerView refs
  const pagerRef = useRef<PagerView>(null);
  const isJumpingRef = useRef(false);
  const pendingJumpIndexRef = useRef<number | null>(null);

  // Issue 1 & 2: スクロール状態追跡（ジャンプ安全性向上）
  const pageScrollStateRef = useRef<"idle" | "dragging" | "settling">("idle");
  const isUserDraggingRef = useRef(false);

  // Reanimated SharedValue for scroll tracking (collapsible-tab-view compatibility)
  const scrollY = useSharedValue(0);

  // Latest horizontal page fraction (position + offset) as reported by
  // onPageScroll. Used by handlePageScrollStateChanged to detect and repair
  // non-integer stops (see forced-snap logic below).
  const lastPageFraction = useSharedValue(0);

  // --- PagerView 用仮想ページ配列 ---
  // 仮想インデックス方式: tabs.length × BUFFER_MULTIPLIER の仮想ページを生成
  // 各ページの realIndex = virtualIndex % tabs.length
  // 初期ページは中央付近に配置し、ユーザーが端に到達する前に巻き戻す
  const BUFFER_MULTIPLIER = 10;
  const pages: VirtualPage[] = useMemo(() => {
    if (!infiniteScroll || tabs.length <= 1) {
      return tabs.map((_, i) => ({ realIndex: i, isClone: false }));
    }
    const totalPages = tabs.length * BUFFER_MULTIPLIER;
    return Array.from({ length: totalPages }, (_, i) => ({
      realIndex: i % tabs.length,
      isClone: false,
    }));
  }, [tabs, infiniteScroll]);

  // 初期ページ: 中央付近で tabs.length の倍数に揃える
  const centerPage = useMemo(() => {
    if (!infiniteScroll || tabs.length <= 1) return 0;
    const center = Math.floor(pages.length / 2);
    return center - (center % tabs.length);
  }, [infiniteScroll, tabs.length, pages.length]);

  // pages ルックアップテーブル（onPageSelected で参照）
  const pageRealIndexesMemo = useMemo(
    () => pages.map((p) => p.realIndex),
    [pages],
  );

  // インデックス正規化
  const normalizeIndex = useCallback(
    (index: number): number => {
      if (!infiniteScroll) {
        return Math.max(0, Math.min(index, tabs.length - 1));
      }
      return ((index % tabs.length) + tabs.length) % tabs.length;
    },
    [tabs.length, infiniteScroll],
  );

  // onTabChange を呼び出すヘルパー
  const triggerTabChange = useCallback(
    (newIndex: number, prevIndex: number) => {
      if (onTabChange && tabs[newIndex] && tabs[prevIndex]) {
        onTabChange({
          tabName: tabs[newIndex].name,
          index: newIndex,
          prevTabName: tabs[prevIndex].name,
          prevIndex: prevIndex,
        });
      }
    },
    [onTabChange, tabs],
  );

  // タブ中央配置は TabBar コンポーネント側で計測済みレイアウトを使って処理

  // --- Lazy mount state (pagerIndex-based) ---
  //
  // v0.2.0 FIX:
  //   infinite scroll の BUFFER_MULTIPLIER=10 によって同じ realIndex を
  //   持つ 10 個の virtual page が存在するため、realIndex ベースの mount tracking では
  //   consumer が 10x mount を強いられていた。pagerIndex をキーにすることで、user が
  //   実際に到達した virtual page だけが children を render される。
  //
  //   With infinite scroll, the library generates `BUFFER_MULTIPLIER * tabs.length`
  //   virtual pages where multiple virtual pages share the same realIndex.
  //   The previous realIndex-based mount tracking caused *every* virtual copy to
  //   render children — meaning a single tab activation triggered up to 10
  //   parallel HeavyContent mounts. Switching the key to pagerIndex ensures only
  //   virtual pages the user actually reaches get their children rendered.
  //
  // Measured impact on a 20-tab example (iPhone 16e):
  //   dispatch latency      400-750 ms  →  13-28 ms    (~25x)
  //   mount-cost per tab    10 × 500 ms →  1 × 50 ms   (~100x)
  //   swipe→content total   3-17 s      →  0.6-0.9 s   (~5-20x)
  const initialMountedPagerIndexes = useMemo(() => {
    const initPagerIdx = infiniteScroll && tabs.length > 1 ? centerPage : 0;
    const indexes = new Set<number>();
    for (let i = -offscreenPageLimit; i <= offscreenPageLimit; i++) {
      const pagerIdx = initPagerIdx + i;
      if (pagerIdx >= 0 && pagerIdx < pages.length) {
        indexes.add(pagerIdx);
      }
    }
    return indexes;
  }, [
    offscreenPageLimit,
    infiniteScroll,
    tabs.length,
    centerPage,
    pages.length,
  ]);

  const [mountedPagerIndexes, setMountedPagerIndexes] = useState<Set<number>>(
    initialMountedPagerIndexes,
  );

  const addMountedPagerRange = useCallback(
    (centerPagerIndex: number) => {
      setMountedPagerIndexes((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (let i = -offscreenPageLimit; i <= offscreenPageLimit; i++) {
          const pagerIdx = centerPagerIndex + i;
          if (pagerIdx >= 0 && pagerIdx < pages.length && !next.has(pagerIdx)) {
            next.add(pagerIdx);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [offscreenPageLimit, pages.length],
  );

  // 初期マウント時に initialMountedPagerIndexes を反映
  useEffect(() => {
    if (!lazy) return;
    setMountedPagerIndexes((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const idx of initialMountedPagerIndexes) {
        if (!next.has(idx)) {
          next.add(idx);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [lazy, initialMountedPagerIndexes]);

  // --- PagerView イベントハンドラ ---

  // 1-C: onTabChange を idle まで遅延（Haptics / Zustand setState 等のアプリ側処理を
  // スワイプ中に走らせないため。setActiveIndex は即実行して正確性を維持）
  const pendingTabChangeRef = useRef<{
    newIndex: number;
    prevIndex: number;
  } | null>(null);

  // pageRealIndexes を SharedValue 化（worklet から参照するため）
  const pageRealIndexesShared = useSharedValue<number[]>(pageRealIndexesMemo);
  useEffect(() => {
    pageRealIndexesShared.value = pageRealIndexesMemo;
  }, [pageRealIndexesMemo, pageRealIndexesShared]);

  // onPageScroll: PagerView のスクロール進捗を UI thread worklet で受け取る
  // 利点: JS thread が busy でも activeIndex 更新が遅延しない
  // useEvent でネイティブイベントを worklet として受け取る
  const handlePageScrollHandler = useEvent<PagerViewOnPageScrollEventData>(
    (event) => {
      "worklet";
      const position = event.position;
      const offset = event.offset;
      // Track the latest fractional scroll position so the JS side can
      // detect a non-integer resting offset once state transitions to idle.
      lastPageFraction.value = position + offset;
      // offset が十分に 0 or 1 に近い時 = ページ確定
      if (offset < 0.01 || offset > 0.99) {
        const finalPosition = offset > 0.5 ? position + 1 : position;
        const indexes = pageRealIndexesShared.value;
        const realIndex = indexes[finalPosition];
        if (realIndex !== undefined && realIndex !== activeIndex.value) {
          activeIndex.value = realIndex;
        }
      }
    },
    ["onPageScroll"],
  );

  // onPageSelected: React re-render トリガー用（軽量、ページジャンプ判定のみ）
  // onPageSelected: lightweight, used for React re-render trigger and jump logic.
  const handlePageSelected = useCallback(
    (e: PagerViewOnPageSelectedEvent) => {
      if (isJumpingRef.current) return;

      const position = e.nativeEvent.position;
      const realIndex = pageRealIndexesMemo[position];
      if (realIndex === undefined) return;

      const prevIndex = prevActiveIndexRef.current;
      prevActiveIndexRef.current = realIndex;

      // activeIndex.value は既に handlePageScrollHandler で更新済み
      // activeIndex.value was already updated by handlePageScrollHandler; re-sync as a safety net.
      activeIndex.value = realIndex;

      if (realIndex !== prevIndex) {
        pendingTabChangeRef.current = { newIndex: realIndex, prevIndex };
      }

      // v0.2.0: lazy mode で pagerIndex 基準の mountedPagerIndexes を更新。
      // v0.2.0: In lazy mode, add the current pagerIndex (and its neighbors) to
      //         mountedPagerIndexes so only virtual pages the user actually
      //         reaches get their children rendered.
      if (lazy) {
        addMountedPagerRange(position);
      }

      // 巻き戻し保険: 端に近づいたら中央に戻す
      // Safety rewind: if we are near the edge of the virtual page buffer,
      // schedule a jump back to the center to keep infinite scroll stable.
      if (infiniteScroll && tabs.length > 1) {
        const edgeThreshold = tabs.length * 5;
        if (
          position < edgeThreshold ||
          position > pages.length - edgeThreshold
        ) {
          pendingJumpIndexRef.current = centerPage + realIndex;
        }
      }
    },
    [
      pageRealIndexesMemo,
      activeIndex,
      infiniteScroll,
      tabs.length,
      pages.length,
      centerPage,
      lazy,
      addMountedPagerRange,
    ],
  );

  // onPageScrollStateChanged: スクロール状態が変わったときに呼ばれる
  // idle になったタイミングでクローン→realジャンプを実行
  const handlePageScrollStateChanged = useCallback(
    (e: {
      nativeEvent: { pageScrollState: "idle" | "dragging" | "settling" };
    }) => {
      const state = e.nativeEvent.pageScrollState;
      pageScrollStateRef.current = state;

      // Issue 2: ドラッグ開始時にペンディングジャンプをキャンセル（state desync 防止）
      if (state === "dragging") {
        isUserDraggingRef.current = true;
        pendingJumpIndexRef.current = null;
        return;
      }
      if (state === "settling") {
        return;
      }

      // state === "idle"
      isUserDraggingRef.current = false;

      // 1-C: idle 時に遅延した onTabChange を flush
      const pendingChange = pendingTabChangeRef.current;
      if (pendingChange) {
        pendingTabChangeRef.current = null;
        triggerTabChange(pendingChange.newIndex, pendingChange.prevIndex);
      }

      if (isJumpingRef.current) {
        isJumpingRef.current = false;
        return;
      }

      const jumpIndex = pendingJumpIndexRef.current;
      if (jumpIndex === null) {
        // Forced snap: the native pager occasionally comes to rest at a
        // fractional offset when the JS thread is busy with first-time
        // children mounts or layout recomputation during deceleration.
        // The tab indicator has already snapped to the integer page via
        // the 0.99 threshold in handlePageScrollHandler, but the PagerView
        // itself stays stuck ~0.2-0.3 pages off, revealing the neighboring
        // page on one side. When we reach idle state, consult the pure
        // helper which decides whether a snap is needed (tolerance, bounds,
        // and NaN guards live there and are covered by unit tests).
        const fraction = lastPageFraction.value;
        const rounded = resolveForcedSnapTarget(fraction, pages.length);
        if (rounded !== null) {
          try {
            pagerRef.current?.setPageWithoutAnimation(rounded);
          } catch {
            // ViewPager2 recycling edge case on Android — swallow the same
            // way the edge-wrap jump does below.
          }
        }
        return;
      }

      // Issue 2: idle 直前に再度 dragging になっていないか再チェック
      if (pageScrollStateRef.current !== "idle") return;

      isJumpingRef.current = true;
      pendingJumpIndexRef.current = null;

      const executeJump = () => {
        // Issue 1: try-catch で ViewPager2 recycling crash を防止
        try {
          pagerRef.current?.setPageWithoutAnimation(jumpIndex);
        } catch {
          // Android ViewPager2 の "Scrapped or attached views may not be recycled" を握りつぶす
        }
        requestAnimationFrame(() => {
          isJumpingRef.current = false;
        });
      };

      // Issue 1: Android では InteractionManager で ViewPager2 のリサイクル完了を待つ
      if (Platform.OS === "android") {
        InteractionManager.runAfterInteractions(() => {
          requestAnimationFrame(executeJump);
        });
      } else {
        requestAnimationFrame(executeJump);
      }
    },
    [triggerTabChange, lastPageFraction, pages.length],
  );

  // タブタップハンドラー
  const handleTabPress = useCallback(
    (newIndex: number) => {
      const normalized = normalizeIndex(newIndex);
      const prevIndex = prevActiveIndexRef.current;

      if (normalized === prevIndex) {
        onFocusedTabPress?.(normalized);
        return;
      }

      prevActiveIndexRef.current = normalized;
      // ✅ SharedValue 書き込み: re-render ゼロ
      // ✅ Direct SharedValue write — no React re-render is triggered.
      activeIndex.value = normalized;
      triggerTabChange(normalized, prevIndex);

      // PagerView のページ切替 + lazy mount の pagerIndex を同期
      // Move PagerView to the target page and sync mountedPagerIndexes.
      const targetPagerIndex =
        infiniteScroll && tabs.length > 1
          ? centerPage + normalized
          : normalized;
      if (lazy) {
        addMountedPagerRange(targetPagerIndex);
      }
      pagerRef.current?.setPage(targetPagerIndex);
    },
    [
      normalizeIndex,
      triggerTabChange,
      onFocusedTabPress,
      activeIndex,
      infiniteScroll,
      tabs.length,
      centerPage,
      lazy,
      addMountedPagerRange,
    ],
  );

  // タブバーのセンタリング・無限スクロールは TabBar 側で計測済みレイアウトを使って処理

  // scrollY を更新する関数（子コンポーネントから呼び出し用）
  const updateScrollY = useCallback(
    (y: number) => {
      scrollY.value = y;
    },
    [scrollY],
  );

  // タブ名の配列
  const tabNames = useMemo(() => tabs.map((t) => t.name), [tabs]);

  // nearbyIndexes: activeIndex ± offscreenPageLimit の範囲（SharedValue で UI thread 計算）
  const tabsLength = tabs.length;
  const nearbyIndexes = useDerivedValue<number[]>(() => {
    const indexes: number[] = [];
    const current = activeIndex.value;
    for (
      let i = current - offscreenPageLimit;
      i <= current + offscreenPageLimit;
      i++
    ) {
      const normalized = infiniteScroll
        ? ((i % tabsLength) + tabsLength) % tabsLength
        : i;
      if (normalized >= 0 && normalized < tabsLength) {
        if (!indexes.includes(normalized)) {
          indexes.push(normalized);
        }
      }
    }
    return indexes;
  }, [activeIndex, offscreenPageLimit, tabsLength, infiniteScroll]);

  // debug log: activeIndex 変更を UI thread で検知して runOnJS で JS thread に通知
  const prevNearbyRef = useRef<number[]>([]);
  const logNearbyChange = useCallback(
    (current: number, nearby: number[]) => {
      if (!debug) return;
      const prev = prevNearbyRef.current;

      debugLog({
        type: "tab-active",
        tabName: tabs[current]?.name ?? "",
        tabIndex: current,
        detail: `nearby: [${nearby.map((i) => tabs[i]?.name).join(", ")}]`,
      });

      for (const idx of nearby) {
        if (idx !== current && !prev.includes(idx)) {
          debugLog({
            type: "tab-nearby",
            tabName: tabs[idx]?.name ?? "",
            tabIndex: idx,
            detail: "prefetch eligible",
          });
        }
      }

      for (const idx of prev) {
        if (!nearby.includes(idx)) {
          debugLog({
            type: "tab-unmounted",
            tabName: tabs[idx]?.name ?? "",
            tabIndex: idx,
          });
        }
      }

      prevNearbyRef.current = nearby;
    },
    [debug, debugLog, tabs],
  );

  useAnimatedReaction(
    () => ({ active: activeIndex.value, nearby: nearbyIndexes.value }),
    (curr, prev) => {
      if (prev && curr.active === prev.active) return;
      runOnJS(logNearbyChange)(curr.active, curr.nearby);
    },
  );

  // 初回マウント時にデバッグログを発火（useAnimatedReaction の初回発火が環境依存のため）
  useEffect(() => {
    if (!debug) return;
    logNearbyChange(activeIndex.value, nearbyIndexes.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Context値
  const contextValue = useMemo(
    () => ({
      activeIndex,
      nearbyIndexes,
      tabs,
      scrollY,
      headerHeight,
      infiniteScroll,
      tabBarCenterActive,
      updateScrollY,
      tabNames,
    }),
    [
      activeIndex,
      nearbyIndexes,
      tabs,
      scrollY,
      headerHeight,
      infiniteScroll,
      tabBarCenterActive,
      updateScrollY,
      tabNames,
    ],
  );

  // コンテンツビュー（PagerView の children として生成）
  const contentViews = useMemo(() => {
    const childrenArray = Children.toArray(children);

    return pages.map((page, pagerIndex) => {
      const child = childrenArray[page.realIndex];

      // lazy モード: まだ一度も nearby になっていない **pagerIndex** は空 View
      // (realIndex ではなく pagerIndex でチェックするのがポイント)
      if (lazy && !mountedPagerIndexes.has(pagerIndex)) {
        return <View key={`pager-lazy-${pagerIndex}`} style={styles.page} />;
      }

      if (isValidElement<{ children: React.ReactNode }>(child)) {
        return (
          <View key={`pager-${pagerIndex}`} style={styles.page}>
            {child.props.children}
          </View>
        );
      }
      return <View key={`pager-empty-${pagerIndex}`} style={styles.page} />;
    });
  }, [children, pages, lazy, mountedPagerIndexes]);

  // 初期ページ（PagerView の initialPage）
  const initialPage = infiniteScroll && tabs.length > 1 ? centerPage : 0;

  return (
    <TabsProvider value={contextValue}>
      <View style={[styles.container, containerStyle]}>
        {/* ヘッダー */}
        {renderHeader && (
          <View
            style={[
              headerHeight > 0 && { height: headerHeight },
              headerContainerStyle,
            ]}
          >
            {renderHeader()}
          </View>
        )}

        {/* タブバー */}
        <View style={[styles.tabBarContainer, tabBarContainerStyle]}>
          {renderTabBar ? (
            renderTabBar({
              tabs,
              activeIndex,
              onTabPress: handleTabPress,
              infiniteScroll,
              centerActive: tabBarCenterActive,
            })
          ) : (
            <DefaultTabBar
              tabs={tabs}
              activeIndex={activeIndex}
              onTabPress={handleTabPress}
              infiniteScroll={infiniteScroll}
              centerActive={tabBarCenterActive}
              ref={tabScrollRef}
            />
          )}
        </View>

        {/* コンテンツエリア（PagerView） */}
        <View style={styles.content}>
          <AnimatedPagerView
            ref={pagerRef}
            style={styles.pagerView}
            initialPage={initialPage}
            offscreenPageLimit={offscreenPageLimit}
            // Reanimated の useEvent ハンドラは worklet オブジェクトなので
            // AnimatedPagerView 経由でのみ正常にネイティブ登録される。
            // 型が合わないため unknown 経由で cast (ランタイムは Reanimated が
            // 直接ネイティブ側でハンドルするため安全)。
            onPageScroll={
              handlePageScrollHandler as unknown as ComponentProps<
                typeof PagerView
              >["onPageScroll"]
            }
            onPageSelected={handlePageSelected}
            onPageScrollStateChanged={handlePageScrollStateChanged}
          >
            {contentViews}
          </AnimatedPagerView>
        </View>
      </View>
    </TabsProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#FFF",
  },
  tabBarContainer: {
    height: TAB_BAR_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: "#E0E0E0",
  },
  content: {
    flex: 1,
  },
  pagerView: {
    flex: 1,
  },
  page: {
    width: SCREEN_WIDTH,
    flex: 1,
  },
});
