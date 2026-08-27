// Composition root：Route/Service 從這裡取得 repository instance，不直接 import 個別檔案，
// 未來 Phase 1C 換成 PostgreSQL 實作時，只需要在這裡替換 export，不用改呼叫端
//
// runInTransaction 也從這裡轉出：多數多步驟寫入已經封裝成單一 repository method 自己管理 transaction，
// 但少數操作橫跨兩個不同 repository（例如撤銷點名時要同時改 attendance_records 與 class_sessions），
// 這種情況由呼叫端（route）用這個 helper 自己包一個 transaction，組合呼叫兩邊「不自帶 transaction」
// 的方法。呼叫端不會、也不需要直接碰 db.prepare/db.exec。
export { runInTransaction } from '../db/index.js';
export { usersRepository } from './users.repository.js';
export { membershipsRepository } from './memberships.repository.js';
export { schoolsRepository } from './schools.repository.js';
export { studentsRepository } from './students.repository.js';
export { teachersRepository } from './teachers.repository.js';
export { schedulingRepository } from './scheduling.repository.js';
export { attendanceRepository } from './attendance.repository.js';
export { seatsRepository } from './seats.repository.js';
export { auditLogsRepository } from './auditLogs.repository.js';
export { financeRepository } from './finance.repository.js';
