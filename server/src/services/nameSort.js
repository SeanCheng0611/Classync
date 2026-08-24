// 學生/教師列表排序：依姓名筆劃（不用加入時間），用 Node 內建 ICU 的筆劃排序 collator
const strokeCollator = new Intl.Collator('zh-Hant-u-co-stroke');

export function sortByName(rows) {
  return rows.slice().sort((a, b) => strokeCollator.compare(a.name, b.name));
}

// 學生列表排序：1. 學校名筆畫 2. 年級低到高 3. 學生姓名筆畫
export function sortStudents(rows) {
  return rows.slice().sort((a, b) => {
    const schoolCompare = strokeCollator.compare(a.school_name || '', b.school_name || '');
    if (schoolCompare !== 0) return schoolCompare;
    if (a.grade !== b.grade) return a.grade - b.grade;
    return strokeCollator.compare(a.name, b.name);
  });
}
