import { useEffect, useRef } from 'react';

// 進入頁面時自動把焦點放到搜尋框，方便直接打字搜尋；
// 觸控裝置（手機/平板）不自動 focus，因為一進頁面就會跳出虛擬鍵盤，畫面被鍵盤佔掉一半反而更難用
export function useAutoFocusSearch() {
  const ref = useRef(null);
  useEffect(() => {
    const isTouchPrimary = window.matchMedia?.('(pointer: coarse)').matches;
    if (!isTouchPrimary) ref.current?.focus();
  }, []);
  return ref;
}
