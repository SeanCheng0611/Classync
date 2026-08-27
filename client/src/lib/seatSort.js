// 座位子系統「上課資訊」清單的排序依據：開始時間／結束時間／教師名／學生名（固定順序，不開放自訂）
export const DEFAULT_SEAT_SORT_ORDER = ['start_time', 'end_time', 'teacher', 'student'];

function compareByKey(key, a, b, teacherName) {
  switch (key) {
    case 'start_time':
      return a.start_slot - b.start_slot;
    case 'end_time':
      return (a.start_slot + a.duration_slots) - (b.start_slot + b.duration_slots);
    case 'teacher':
      return teacherName(a.teacher_id).localeCompare(teacherName(b.teacher_id));
    case 'student':
      return (a.students[0]?.name || '').localeCompare(b.students[0]?.name || '');
    default:
      return 0;
  }
}

// 依設定的鍵優先序比較兩堂課；teacherName 是外部傳入的查表函式（session.teacher_id -> 姓名）
export function compareSessionsBySeatOrder(order, teacherName) {
  return (a, b) => {
    for (const key of order) {
      const cmp = compareByKey(key, a, b, teacherName);
      if (cmp !== 0) return cmp;
    }
    return 0;
  };
}

// 同一位教師若有兩堂課，強制排在相鄰兩列（先依 comparator 排出每位教師代表順序，組內再套用同一套 comparator）
export function groupSessionsByTeacher(sessions, comparator) {
  const byTeacher = new Map();
  for (const s of sessions) {
    const list = byTeacher.get(s.teacher_id) || [];
    list.push(s);
    byTeacher.set(s.teacher_id, list);
  }
  const groups = Array.from(byTeacher.values()).map((list) => list.slice().sort(comparator));
  groups.sort((a, b) => comparator(a[0], b[0]));
  return groups.flat();
}
