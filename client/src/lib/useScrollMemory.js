import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

// 記住每個路徑離開當下的捲動位置（存在記憶體，重新整理會重置），
// 回到該頁（例如按「返回」）時自動還原；第一次造訪的新頁面則捲到最上面。
// 頁面內容多半是非同步載入，剛進頁面時高度通常還沒撐開；如果只在進頁面當下 scrollTo 一次，
// 瀏覽器會把捲動位置夾在當下（還很短的）頁面高度內，資料載入完、頁面長高後也不會自動補回去，
// 所以用 ResizeObserver 在頁面高度持續變化的這段期間重新套用捲動位置，直到高度穩定或超過時間上限
const scrollStore = new Map();
const RESTORE_WINDOW_MS = 1500;

// 學生/教師列表回來時改用「捲到剛剛看的那筆」機制（見 scrollAnchor.js），比記像素高度準確，這裡不重複處理
const ANCHORED_PATHS = new Set(['/students', '/teachers']);

export function useScrollMemory() {
  const location = useLocation();
  const pathRef = useRef(location.pathname);

  useEffect(() => {
    pathRef.current = location.pathname;
    if (ANCHORED_PATHS.has(location.pathname)) return;
    const saved = scrollStore.get(location.pathname) ?? 0;

    const applyScroll = () => window.scrollTo(0, saved);
    applyScroll();

    const observer = new ResizeObserver(applyScroll);
    observer.observe(document.documentElement);
    const stopTimer = setTimeout(() => observer.disconnect(), RESTORE_WINDOW_MS);

    const onScroll = () => scrollStore.set(pathRef.current, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
      scrollStore.set(pathRef.current, window.scrollY);
      observer.disconnect();
      clearTimeout(stopTimer);
    };
  }, [location.pathname]);
}
