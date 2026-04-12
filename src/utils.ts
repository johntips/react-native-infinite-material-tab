/**
 * 計測済みレイアウトを使ってアクティブタブを画面中央に配置するスクロール位置を計算
 * TabBar の centering useEffect で使用される実際の計算式
 *
 * @param layoutX - タブの x 座標（onLayout で計測済み）
 * @param layoutWidth - タブの幅（onLayout で計測済み）
 * @param screenWidth - 画面の幅
 * @returns スクロール位置（x座標、0 以上）
 */
export const computeCenterScrollX = (
  layoutX: number,
  layoutWidth: number,
  screenWidth: number,
): number => {
  const scrollX = layoutX + layoutWidth / 2 - screenWidth / 2;
  return Math.max(0, scrollX);
};

/**
 * 無限スクロール時のアクティブ仮想インデックスを計算
 * realIndex を中央セット（3倍仮想タブの2番目のセット）にマッピング
 *
 * @param activeIndex - 実タブのインデックス (0..tabs.length-1)
 * @param tabsLength - タブの総数
 * @param infiniteScroll - 無限スクロールが有効か
 * @returns 仮想インデックス
 */
export const computeActiveVirtualIndex = (
  activeIndex: number,
  tabsLength: number,
  infiniteScroll: boolean,
): number => {
  if (!infiniteScroll) return activeIndex;
  return tabsLength + activeIndex;
};

/**
 * タブの計測済みレイアウト（x座標・幅）をシミュレート
 * 実際の onLayout で得られる値と同等のレイアウトを生成
 *
 * @param tabWidths - 各タブの幅の配列
 * @param paddingHorizontal - ScrollView の contentContainerStyle の paddingHorizontal
 * @returns Map<virtualIndex, { x, width }>
 */
export const simulateTabLayouts = (
  tabWidths: number[],
  paddingHorizontal = 8,
): Map<number, { x: number; width: number }> => {
  const layouts = new Map<number, { x: number; width: number }>();
  let currentX = paddingHorizontal;
  for (let i = 0; i < tabWidths.length; i++) {
    const width = tabWidths[i] ?? 100;
    layouts.set(i, { x: currentX, width });
    currentX += width;
  }
  return layouts;
};

/**
 * タブを画面中央に配置するためのスクロール位置を計算
 * 動的タブ幅に対応
 *
 * @param activeIndex - アクティブなタブのインデックス
 * @param tabWidths - 各タブの幅の配列
 * @param screenWidth - 画面の幅
 * @param defaultWidth - タブ幅が未計測の場合のフォールバック値
 * @returns スクロール位置（x座標）
 */
export const getCenterScrollPosition = (
  activeIndex: number,
  tabWidths: number[],
  screenWidth: number,
  defaultWidth?: number,
): number => {
  const fallback = defaultWidth ?? 100;

  // アクティブタブの中心位置を計算
  let tabCenterX = 0;
  for (let i = 0; i < activeIndex; i++) {
    tabCenterX += tabWidths[i] ?? fallback;
  }
  tabCenterX += (tabWidths[activeIndex] ?? fallback) / 2;

  // 画面中央に配置するためのスクロール位置
  const scrollX = tabCenterX - screenWidth / 2;

  // 負の値は0にクランプ（左端より左にはスクロールできない）
  return Math.max(0, scrollX);
};

/**
 * Decide whether the native pager is resting off-integer and, if so, which
 * integer page it should be forced onto.
 *
 * The native pager (UIScrollView `pagingEnabled` on iOS, `ViewPager2` on
 * Android) normally snaps to an integer page after deceleration finishes.
 * When the JS thread is busy with first-mount children (heavy list
 * layout, data-fetching hooks, image prefetch) during that deceleration,
 * the UI thread's layout pass can interrupt the snap and leave the pager
 * at a fractional scroll offset. The tab indicator has already moved to
 * the target page via the 0.99 threshold in `onPageScroll`, so the UI
 * appears settled while ~20-30% of the neighboring page is still showing.
 *
 * This helper is the pure logic decision: given the latest fraction
 * reported by `onPageScroll` and the total number of virtual pages, it
 * returns the target integer to snap to — or `null` if no snap is needed.
 *
 * Design notes:
 * - Dimensionless. Takes a fraction (unit = pages), not a pixel distance.
 *   The same thresholds work on 320px phones, 414px phones, and 768px
 *   tablets without tuning.
 * - Tolerant to float noise. Reports of `0.0000001` or `0.999999` are
 *   treated as clean settles; only gaps larger than `TOLERANCE` trigger
 *   a snap.
 * - Math.round (not floor / ceil) — the native pager already decided
 *   "which way" it was decelerating; we just complete the half it
 *   couldn't finish.
 * - NaN / Infinity / out-of-range guards. Called from `idle` state, which
 *   can fire before the first `onPageScroll`, yielding an unwritten
 *   SharedValue or an index outside the virtual page array.
 *
 * @param fraction - latest `position + offset` from `onPageScroll`
 * @param pagesLength - total count of virtual pages
 * @returns integer page to snap to, or `null` if already aligned / invalid
 */
export const resolveForcedSnapTarget = (
  fraction: number,
  pagesLength: number,
): number | null => {
  // Tolerance is in page units. `0.01` ≈ 1% of a page width.
  // Below this is indistinguishable from a clean native snap; above this
  // reliably indicates a real mid-decelerate abort on iOS simulators and
  // physical devices.
  const TOLERANCE = 0.01;

  if (!Number.isFinite(fraction)) return null;
  if (!Number.isFinite(pagesLength) || pagesLength <= 0) return null;
  // Negative fractions can't happen on a healthy PagerView; treat them as
  // invalid to avoid `Math.round(-0.4) === -0` leaking through the bounds
  // check (`-0 >= 0` is true in JS).
  if (fraction < 0) return null;

  const rounded = Math.round(fraction);
  if (rounded < 0 || rounded >= pagesLength) return null;

  const delta = Math.abs(fraction - rounded);
  if (delta <= TOLERANCE) return null;

  return rounded;
};
