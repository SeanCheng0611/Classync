// Centralized page key registry. 保持與 server/src/constants/pageKeys.js 一致（兩邊分屬不同 build，
// 沒有共用 package，改動時要記得同步兩邊）。用來讓每個主要 Page 的 Log 查詢有一致、可預期的 key，
// 不要讓各處自由輸入 "Student Page" / "students-page" / "Students" 這種不一致的字串。
export const PAGE_KEYS = {
  DASHBOARD: 'dashboard',
  STUDENTS: 'students',
  TEACHERS: 'teachers',
  SCHEDULE: 'schedule',
  ATTENDANCE: 'attendance',
  SEATS: 'seats',
  FINANCE: 'finance',
  INVOICES: 'invoices',
  PAYSLIPS: 'payslips',
  MEMBERS: 'members',
  NOTES: 'notes',
  TRASH: 'trash',
  SETTINGS: 'settings',
  AUTH: 'auth',
  ADMIN: 'admin',
  SYSTEM: 'system',
};

// route path prefix -> page key，Layout 用這個推導目前頁面的 page_key，決定「查看此頁 Log」要撈哪個 key
export const ROUTE_PAGE_KEYS = [
  ['/students', PAGE_KEYS.STUDENTS],
  ['/teachers', PAGE_KEYS.TEACHERS],
  ['/schedule', PAGE_KEYS.SCHEDULE],
  ['/attendance', PAGE_KEYS.ATTENDANCE],
  ['/seats', PAGE_KEYS.SEATS],
  ['/finance', PAGE_KEYS.FINANCE],
  ['/invoices', PAGE_KEYS.INVOICES],
  ['/payslips', PAGE_KEYS.PAYSLIPS],
  ['/members', PAGE_KEYS.MEMBERS],
  ['/notes', PAGE_KEYS.NOTES],
  ['/settings', PAGE_KEYS.SETTINGS],
  ['/admin', PAGE_KEYS.ADMIN],
];

export function pageKeyForPath(pathname) {
  const match = ROUTE_PAGE_KEYS.find(([prefix]) => pathname.startsWith(prefix));
  return match ? match[1] : null;
}
