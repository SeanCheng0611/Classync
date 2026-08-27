// Centralized page key registry. 保持與 client/src/constants/pageKeys.js 一致（兩邊分屬不同 build，
// 沒有共用 package，改動時要記得同步兩邊）。這是 log 可查詢/可過濾的關鍵，禁止各處自由輸入字串。
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

export const PAGE_KEY_VALUES = Object.values(PAGE_KEYS);
