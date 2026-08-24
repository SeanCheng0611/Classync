// 從學生/教師詳細頁按「返回列表」時，記住剛剛看的是哪一位，讓列表頁回來時該筆資料直接捲到最上面。
// 比記憶捲動高度準確：列表筆數、排序可能已經變動，且列表資料多半非同步載入，記高度容易撲空
const lastVisited = new Map(); // listPath -> id

export function setLastVisitedId(listPath, id) {
  lastVisited.set(listPath, id);
}

// 讀取後即清除，避免下次單純重新整理/切分類時又誤觸一次捲動
export function takeLastVisitedId(listPath) {
  const id = lastVisited.get(listPath);
  lastVisited.delete(listPath);
  return id;
}

// 把目標列捲到頂端，但保留一點空間（預設約 1~2 列的高度），避免被頂部 sticky 的 app-header 擋住
export function scrollRowIntoView(elementId, offset = 100) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top) });
}
