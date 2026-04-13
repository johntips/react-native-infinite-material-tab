import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InteractionManager, StyleSheet, View } from "react-native";
import {
  Tabs,
  useActiveTabIndexValue,
  useIsNearby,
  useTabs,
} from "react-native-infinite-material-tab";
import type { NewsItem } from "../data/newsItems";
import { getNewsByCategory } from "../data/newsItems";
import {
  useMockAuth,
  useMockEventCenter,
  useMockImagePrefetch,
  useMockQuery,
  useMockScrollToTop,
  useMockScrollTracking,
  useMockStore,
  useMockThrottledRefresh,
} from "../hooks/useMockHooks";
import { NewsCard } from "./NewsCard";

interface NewsListProps {
  category: string;
}

const renderItem = ({ item }: { item: NewsItem }) => <NewsCard item={item} />;
const keyExtractor = (item: NewsItem) => item.id;

/**
 * ニュースリスト軽量ラッパー
 *
 * Async Follow Design:
 * - アクティブ化前: スケルトンのみ表示（hooks 4個）
 * - アクティブ化後: InteractionManager でスワイプアニメ完了を待ち、重いコンテンツをマウント
 * → タブスワイプを JS thread から完全に切り離し、60fps を担保
 */
export const NewsList: React.FC<NewsListProps> = memo(({ category }) => {
  const tabName = category.toLowerCase();
  const activeIndex = useActiveTabIndexValue();
  const tabs = useTabs();
  const isActive = tabs[activeIndex]?.name === tabName;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isActive && !ready) {
      const handle = InteractionManager.runAfterInteractions(() => {
        setReady(true);
      });
      return () => handle.cancel();
    }
  }, [isActive, ready]);

  if (!ready) {
    return <NewsListSkeleton category={category} />;
  }

  return <HeavyNewsListContent category={category} />;
});

NewsList.displayName = "NewsList";

/**
 * スケルトン（hooks ゼロ — 即座にレンダリング）
 * タブスワイプ中は必ずこれが表示される。
 */
function NewsListSkeleton({ category }: { category?: string }) {
  const testID = category
    ? `list-${category.toLowerCase().replace(/\s/g, "-")}-skeleton`
    : "list-skeleton";
  return (
    <View style={styles.container} testID={testID}>
      {Array.from({ length: 5 }).map((_, i) => (
        <View key={i} style={styles.skeletonCard}>
          <View style={styles.skeletonImage} />
          <View style={styles.skeletonContent}>
            <View style={styles.skeletonTitle} />
            <View style={styles.skeletonSummary} />
            <View style={styles.skeletonMeta} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * 重量級コンテンツコンポーネント
 *
 * 実アプリ想定の hooks 負荷を再現:
 * - Context / Store 参照（軽量、同期）
 * - 非同期データ取得（重い、300ms 遅延）
 * - Reanimated 駆動のスクロール追跡（UI thread）
 * - 大量の useState / useEffect / useCallback / useMemo
 *
 * 合計 30+ hooks が直列・並列で実行される状況を作り出し、
 * この重さでもタブスワイプが影響を受けないことを検証する。
 */
const HeavyNewsListContent = memo(function HeavyNewsListContent({
  category,
}: {
  category: string;
}) {
  // --- Per-tab isFocused (README: best practice #2) ---
  // 親から isFocused を prop で受け取ると tab change 時に全 tab が
  // re-render する。ここでは tab name を直接 store 相当 (SharedValue 経由の
  // hook) から参照し、current/previous の 2 タブだけが re-render するように
  // する。
  const activeIndex = useActiveTabIndexValue();
  const tabs = useTabs();
  const tabName = category.toLowerCase();
  const isFocused = tabs[activeIndex]?.name === tabName;

  // --- Sticky enabled (README: best practice #1) ---
  // 一度 focus されたら以降 enabled は true 固定。swipe で flip させると
  // subscription restart + refetch が毎回走って JS thread を占有する。
  const queryEnabledRef = useRef(false);
  if (isFocused) queryEnabledRef.current = true;

  // --- Context / Store 参照（軽量、並列）---
  const { authenticated, user } = useMockAuth();
  const { pendingInvalidation, pendingToast, clearPending } = useMockStore();
  const { event, refetchEvent } = useMockEventCenter();

  // --- ローカル state (5個) ---
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [imageReloadKey, setImageReloadKey] = useState(0);
  const [_selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [_errorCount, setErrorCount] = useState(0);

  // --- ref (5個) ---
  const listRef = useRef(null);
  const mountTimeRef = useRef(Date.now());
  const prevSortOrderRef = useRef(sortOrder);
  const scrollPositionRef = useRef(0);
  const isFirstMountRef = useRef(true);

  // --- Reanimated 駆動フック（UI thread、並列）---
  const { scrollY } = useMockScrollTracking();

  // --- カスタムフック（並列）---
  // 注意: 以下の destructured 値はパフォーマンス負荷シミュレーションのため意図的に
  // 未使用 (underscore prefix で lint 除外)。hooks 自体は実行されて cost を発生させる。
  useMockScrollToTop(listRef);
  const { handleRefresh: _handleRefresh, refreshing: _refreshing } =
    useMockThrottledRefresh({
      onRefresh: async () => {
        // noop
      },
    });
  const isNearby = useIsNearby(category.toLowerCase());

  // --- 非同期データ取得（重い、直列）---
  // Best practice #1 のフル適用: enabled は sticky、refetchInterval は
  // isFocused ゲート。N タブ同時の定期通信による JS thread 占有を回避し、
  // library の forced-snap (onPageScrollStateChanged:idle) が安定発火する
  // 環境を維持する。
  const fetcher = useCallback(() => getNewsByCategory(category), [category]);
  const { data, isPending } = useMockQuery(`news-${category}`, fetcher, {
    enabled: queryEnabledRef.current,
    delayMs: 300,
    refetchIntervalMs: 5 * 60 * 1000, // 5 分
    refetchWhenUnfocused: false,
    isFocused,
  });
  const { data: _userStats } = useMockQuery(
    `user-stats-${user.id}`,
    useCallback(() => ({ totalReads: 42, streak: 7 }), [user.id]),
    {
      enabled: queryEnabledRef.current,
      delayMs: 200,
    },
  );
  const { data: _trendingTags } = useMockQuery(
    `trending-tags`,
    useCallback(() => ["AI", "Space", "Climate"], []),
    {
      enabled: queryEnabledRef.current,
      delayMs: 150,
    },
  );

  useMockImagePrefetch(data ?? []);

  // --- useEffect 群（8個、並列）---
  useEffect(() => {
    // マウント時のログ
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      if (__DEV__) {
        const elapsed = Date.now() - mountTimeRef.current;
        console.log(
          `[HeavyNewsList] ${category}: mounted in ${elapsed}ms (30+ hooks)`,
        );
      }
    }
  }, [category]);

  useEffect(() => {
    // 認証状態変更時の処理
    if (authenticated) {
      // noop (cost simulation)
    }
  }, [authenticated]);

  useEffect(() => {
    // ソート変更追跡
    if (prevSortOrderRef.current !== sortOrder) {
      prevSortOrderRef.current = sortOrder;
      setImageReloadKey((k) => k + 1);
    }
  }, [sortOrder]);

  useEffect(() => {
    // ストアの pending 処理
    if (pendingInvalidation || pendingToast) {
      clearPending();
    }
  }, [pendingInvalidation, pendingToast, clearPending]);

  useEffect(() => {
    // イベント購読
    if (event) {
      refetchEvent();
    }
  }, [event, refetchEvent]);

  useEffect(() => {
    // nearby プリフェッチ tracking
    if (isNearby && __DEV__) {
      // noop
    }
  }, [isNearby]);

  useEffect(() => {
    // data 変更時のサイドエフェクト
    if (data) {
      // noop
    }
  }, [data]);

  useEffect(() => {
    // cleanup
    return () => {
      scrollPositionRef.current = 0;
    };
  }, []);

  // --- useCallback (5個、並列) ---
  const _handleScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      scrollPositionRef.current = e.nativeEvent.contentOffset.y;
      scrollY.value = e.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );

  const _handleSortChange = useCallback(() => {
    setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
  }, []);

  const _handleFilterClear = useCallback(() => {
    setFilterTag(null);
  }, []);

  const _handleItemSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const _handleError = useCallback(() => {
    setErrorCount((c) => c + 1);
  }, []);

  // --- useMemo (2個、重いデータ変換) ---
  const sortedData = useMemo(() => {
    if (!data) return [];
    const sorted = [...data].sort((a, b) =>
      sortOrder === "desc"
        ? b.publishedAt.localeCompare(a.publishedAt)
        : a.publishedAt.localeCompare(b.publishedAt),
    );
    return sorted;
  }, [data, sortOrder]);

  const filteredData = useMemo(() => {
    if (!filterTag) return sortedData;
    return sortedData.filter((item) => item.tags.includes(filterTag));
  }, [sortedData, filterTag]);

  const containerTestID = `list-${category.toLowerCase().replace(/\s/g, "-")}`;

  if (isPending || !data) {
    return <NewsListSkeleton category={category} />;
  }

  return (
    <View style={styles.container} testID={containerTestID}>
      <Tabs.FlashList
        data={filteredData}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={460}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
        drawDistance={800}
        extraData={imageReloadKey}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F5F5F5",
  },
  contentContainer: {
    padding: 16,
  },
  skeletonCard: {
    backgroundColor: "#FFF",
    borderRadius: 16,
    marginHorizontal: 16,
    marginTop: 16,
    overflow: "hidden",
  },
  skeletonImage: {
    height: 220,
    backgroundColor: "#E8E8E8",
  },
  skeletonContent: {
    padding: 16,
  },
  skeletonTitle: {
    height: 20,
    width: "80%",
    backgroundColor: "#E8E8E8",
    borderRadius: 4,
    marginBottom: 8,
  },
  skeletonSummary: {
    height: 14,
    width: "95%",
    backgroundColor: "#E8E8E8",
    borderRadius: 4,
    marginBottom: 12,
  },
  skeletonMeta: {
    height: 12,
    width: "40%",
    backgroundColor: "#E8E8E8",
    borderRadius: 4,
  },
});
