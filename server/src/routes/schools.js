import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireAuth, requireOwner } from '../auth/middleware.js';
import { broadcastChange, broadcastForceReload } from '../realtime/index.js';
import { addToTrash, captureMembership } from '../services/trash.js';

export const schoolsRouter = Router();
schoolsRouter.use(requireAuth);

function getMembership(userId, schoolId) {
  return db.prepare('SELECT * FROM memberships WHERE user_id = ? AND school_id = ?').get(userId, schoolId);
}

function genInviteCode() {
  return nanoid(8).toUpperCase();
}

// 建立新補習班：僅平台最高權限者（owner）可執行，一般使用者只能用邀請碼加入既有補習班
schoolsRouter.post('/', requireOwner, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const schoolId = nanoid();
  const inviteCode = genInviteCode();
  const membershipId = nanoid();

  db.prepare('INSERT INTO schools (id, name, invite_code) VALUES (?, ?, ?)').run(
    schoolId,
    name,
    inviteCode
  );
  db.prepare(
    'INSERT INTO memberships (id, user_id, school_id, role) VALUES (?, ?, ?, ?)'
  ).run(membershipId, req.user.id, schoolId, 'admin');

  res.status(201).json({ id: schoolId, name, invite_code: inviteCode, role: 'admin' });
});

schoolsRouter.get('/mine', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, m.role
       FROM memberships m JOIN schools s ON s.id = m.school_id
       WHERE m.user_id = ?`
    )
    .all(req.user.id);
  res.json(rows);
});

// 管理者查看/更新邀請碼與補習班基本資料
schoolsRouter.get('/:schoolId', (req, res) => {
  const membership = db
    .prepare('SELECT * FROM memberships WHERE user_id = ? AND school_id = ?')
    .get(req.user.id, req.params.schoolId);
  if (!membership) return res.status(403).json({ error: 'not a member' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });
  res.json({ ...school, role: membership.role });
});

// 學生單堂預設金額（依年級級距）：新增固定課程/單堂加課時的預設單價，僅管理者可調整
schoolsRouter.put('/:schoolId/tuition-defaults', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  const {
    default_price_grade_1_6 = school.default_price_grade_1_6,
    default_price_grade_7_9 = school.default_price_grade_7_9,
    default_price_grade_10_12 = school.default_price_grade_10_12,
  } = req.body;

  db.prepare(
    `UPDATE schools SET default_price_grade_1_6 = ?, default_price_grade_7_9 = ?, default_price_grade_10_12 = ? WHERE id = ?`
  ).run(
    Number(default_price_grade_1_6) || 0,
    Number(default_price_grade_7_9) || 0,
    Number(default_price_grade_10_12) || 0,
    req.params.schoolId
  );

  broadcastChange(req.params.schoolId, 'tuition-defaults');
  res.json({ ...db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId), role: membership.role });
});

// 「設定」子系統：一對多班級人數上限、時間選單優先範圍、固定課預設展開月數；僅管理者可調整
schoolsRouter.put('/:schoolId/scheduling-settings', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  const {
    group_class_max_students = school.group_class_max_students,
    time_picker_range_start = school.time_picker_range_start,
    time_picker_range_end = school.time_picker_range_end,
    default_schedule_span_months = school.default_schedule_span_months,
    default_class_duration_hours = school.default_class_duration_hours,
  } = req.body;

  const maxStudents = Number(group_class_max_students);
  if (!Number.isInteger(maxStudents) || maxStudents < 1) {
    return res.status(400).json({ error: '一對多班級人數上限需為正整數' });
  }
  const spanMonths = Number(default_schedule_span_months);
  if (!Number.isInteger(spanMonths) || spanMonths < 1) {
    return res.status(400).json({ error: '固定課預設展開月數需為正整數' });
  }
  if (!/^\d{2}:\d{2}$/.test(time_picker_range_start) || !/^\d{2}:\d{2}$/.test(time_picker_range_end)) {
    return res.status(400).json({ error: '時間格式需為 HH:MM' });
  }
  const durationHours = Number(default_class_duration_hours);
  if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 24) {
    return res.status(400).json({ error: '預設堂課時長需為大於 0 的數字' });
  }

  db.prepare(
    `UPDATE schools SET group_class_max_students = ?, time_picker_range_start = ?, time_picker_range_end = ?, default_schedule_span_months = ?, default_class_duration_hours = ?
     WHERE id = ?`
  ).run(maxStudents, time_picker_range_start, time_picker_range_end, spanMonths, durationHours, req.params.schoolId);

  broadcastChange(req.params.schoolId, 'scheduling-settings');
  res.json({ ...db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId), role: membership.role });
});

// 科目選單：排課表單的科目下拉選項，僅管理者可調整；「恢復預設」由前端直接送出預設清單即可，不需要另外的端點
schoolsRouter.put('/:schoolId/subjects', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  const { subjects } = req.body;
  if (!Array.isArray(subjects)) return res.status(400).json({ error: 'subjects must be an array' });
  const cleaned = [...new Set(subjects.map((s) => String(s).trim()).filter(Boolean))];
  if (cleaned.length === 0) return res.status(400).json({ error: '至少需要保留一個科目' });

  db.prepare('UPDATE schools SET subjects = ? WHERE id = ?').run(JSON.stringify(cleaned), req.params.schoolId);

  broadcastChange(req.params.schoolId, 'scheduling-settings');
  res.json({ ...db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId), role: membership.role });
});

const TYPE_COLOR_KEYS = ['regular', 'extra', 'makeup', 'leave'];
const SWATCH_KEYS = ['camel', 'red', 'green', 'blue', 'purple', 'gray'];

// 課表／點名子系統的課堂類型標籤顏色：固定課(regular)/加課(extra)/調課(makeup) 各挑一個莫蘭迪色票代號，僅管理者可調整
schoolsRouter.put('/:schoolId/type-colors', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  const { type_colors } = req.body;
  if (!type_colors || typeof type_colors !== 'object' || Array.isArray(type_colors)) {
    return res.status(400).json({ error: 'type_colors must be an object' });
  }
  for (const [key, value] of Object.entries(type_colors)) {
    if (!TYPE_COLOR_KEYS.includes(key)) return res.status(400).json({ error: `不支援的課堂類型：${key}` });
    if (!SWATCH_KEYS.includes(value)) return res.status(400).json({ error: `不支援的色票：${value}` });
  }

  db.prepare('UPDATE schools SET type_colors = ? WHERE id = ?').run(JSON.stringify(type_colors), req.params.schoolId);

  broadcastChange(req.params.schoolId, 'scheduling-settings');
  res.json({ ...db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId), role: membership.role });
});

const SCHEDULE_TYPE_ORDER_KEYS = ['regular', 'extra', 'makeup'];

// 課表子系統：同一時段內固定課/加課/調課的排列順序，僅管理者可調整；已請假的課堂仍照原本類型排序，不會被排到最後
schoolsRouter.put('/:schoolId/schedule-type-order', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  const { schedule_type_order } = req.body;
  const valid =
    Array.isArray(schedule_type_order) &&
    schedule_type_order.length === SCHEDULE_TYPE_ORDER_KEYS.length &&
    SCHEDULE_TYPE_ORDER_KEYS.every((k) => schedule_type_order.includes(k));
  if (!valid) {
    return res.status(400).json({ error: 'schedule_type_order 需包含 regular/extra/makeup 各一次' });
  }

  db.prepare('UPDATE schools SET schedule_type_order = ? WHERE id = ?').run(
    JSON.stringify(schedule_type_order),
    req.params.schoolId
  );

  broadcastChange(req.params.schoolId, 'scheduling-settings');
  res.json({ ...db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId), role: membership.role });
});

// 點名子系統：同一時段內固定課/加課/調課的排列順序，邏輯與 schedule-type-order 相同但獨立設定，僅管理者可調整
schoolsRouter.put('/:schoolId/attendance-type-order', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  const { attendance_type_order } = req.body;
  const valid =
    Array.isArray(attendance_type_order) &&
    attendance_type_order.length === SCHEDULE_TYPE_ORDER_KEYS.length &&
    SCHEDULE_TYPE_ORDER_KEYS.every((k) => attendance_type_order.includes(k));
  if (!valid) {
    return res.status(400).json({ error: 'attendance_type_order 需包含 regular/extra/makeup 各一次' });
  }

  db.prepare('UPDATE schools SET attendance_type_order = ? WHERE id = ?').run(
    JSON.stringify(attendance_type_order),
    req.params.schoolId
  );

  broadcastChange(req.params.schoolId, 'scheduling-settings');
  res.json({ ...db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId), role: membership.role });
});

// 「設定」頁面本身各設定區塊的顯示順序：只驗證是「不重複的非空字串陣列」，不比對固定清單——
// 區塊的 key 集合會隨程式改版增減，前端 parseSectionOrder 已經會過濾掉不存在的 key、把新出現的補到最後，
// 這裡沒必要跟前端維護同一份清單造成兩邊要同步更新的負擔
schoolsRouter.put('/:schoolId/settings-section-order', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  const { settings_section_order } = req.body;
  const valid =
    Array.isArray(settings_section_order) &&
    settings_section_order.every((k) => typeof k === 'string' && k) &&
    new Set(settings_section_order).size === settings_section_order.length;
  if (!valid) {
    return res.status(400).json({ error: 'settings_section_order 必須是不重複的非空字串陣列' });
  }

  db.prepare('UPDATE schools SET settings_section_order = ? WHERE id = ?').run(
    JSON.stringify(settings_section_order),
    req.params.schoolId
  );

  broadcastChange(req.params.schoolId, 'scheduling-settings');
  res.json({ ...db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId), role: membership.role });
});

// 座位系統版面（座位排列位置）：admin/front_desk 皆可調整，layout 是二維陣列，每個內層陣列（一橫排）最多 4 個座位編號
schoolsRouter.put('/:schoolId/seat-layout', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || !['admin', 'front_desk'].includes(membership.role)) return res.status(403).json({ error: 'forbidden' });

  const { layout } = req.body;
  const valid =
    Array.isArray(layout) &&
    layout.every((row) => Array.isArray(row) && row.length <= 4 && row.every((n) => Number.isInteger(n) && n >= 1));
  if (!valid) return res.status(400).json({ error: '座位版面格式錯誤，每排最多 4 個座位' });

  db.prepare('UPDATE schools SET seat_layout = ? WHERE id = ?').run(JSON.stringify(layout), req.params.schoolId);
  broadcastChange(req.params.schoolId, 'seat-layout');
  res.json({ layout });
});

// 刪除整間補習班：僅平台最高權限者（owner）可執行，FK cascade 會一併清除其下所有資料
schoolsRouter.delete('/:schoolId', requireOwner, (req, res) => {
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(req.params.schoolId);
  if (!school) return res.status(404).json({ error: 'not found' });

  db.prepare('DELETE FROM schools WHERE id = ?').run(req.params.schoolId);
  res.status(204).end();
});

// 成員列表：該補習班的 admin 可查看
schoolsRouter.get('/:schoolId/members', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const rows = db
    .prepare(
      `SELECT m.id, m.role, m.teacher_id, u.id as user_id, u.display_name, u.picture_url, u.is_owner
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.school_id = ?
       ORDER BY m.role, u.display_name`
    )
    .all(req.params.schoolId);
  res.json(rows);
});

// 將成員（教師角色）連結到對應的教師檔案，教師才能替自己的課點名；也可在此變更成員角色（管理者/教師）
schoolsRouter.put('/:schoolId/members/:membershipId', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const target = db
    .prepare(
      `SELECT m.*, u.is_owner as target_is_owner FROM memberships m
       JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.school_id = ?`
    )
    .get(req.params.membershipId, req.params.schoolId);
  if (!target) return res.status(404).json({ error: 'not found' });

  const { teacher_id, role } = req.body;

  // 角色調整規則：平台擁有者可調整任何人的權限；一般管理者只能調整「非管理者」（教師/櫃台）的權限，不能調整其他管理者
  // 沒有人（包含擁有者本人）可以調整自己或平台擁有者的權限
  if (role && role !== target.role) {
    if (!['admin', 'teacher', 'front_desk'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    if (target.user_id === req.user.id) return res.status(403).json({ error: '無法調整自己的權限' });
    if (target.target_is_owner) return res.status(403).json({ error: '無法調整系統擁有者的權限' });
    if (!req.user.is_owner && target.role === 'admin') return res.status(403).json({ error: '無法調整管理者的權限' });
  }

  const nextRole = role || target.role;
  const nextTeacherId = nextRole !== 'teacher' ? null : teacher_id !== undefined ? teacher_id : target.teacher_id;
  if (nextTeacherId) {
    const teacher = db
      .prepare('SELECT * FROM teachers WHERE id = ? AND school_id = ?')
      .get(nextTeacherId, req.params.schoolId);
    if (!teacher) return res.status(400).json({ error: 'teacher not found in this school' });
  }

  db.prepare('UPDATE memberships SET teacher_id = ?, role = ? WHERE id = ?').run(
    nextTeacherId || null,
    nextRole,
    req.params.membershipId
  );

  broadcastChange(req.params.schoolId, 'members');
  if (role && role !== target.role) {
    broadcastForceReload(req.params.schoolId, target.user_id);
  }

  res.json(db.prepare('SELECT * FROM memberships WHERE id = ?').get(req.params.membershipId));
});

// 移除成員（踢出帳號）：該補習班的 admin 可執行，但不可移除最後一位 admin
schoolsRouter.delete('/:schoolId/members/:membershipId', (req, res) => {
  const membership = getMembership(req.user.id, req.params.schoolId);
  if (!membership || membership.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const target = db
    .prepare(
      `SELECT m.*, u.is_owner as target_is_owner FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.id = ? AND m.school_id = ?`
    )
    .get(req.params.membershipId, req.params.schoolId);
  if (!target) return res.status(404).json({ error: 'not found' });
  if (target.target_is_owner) return res.status(403).json({ error: '無法移除系統擁有者' });

  if (target.role === 'admin') {
    const { count } = db
      .prepare("SELECT COUNT(*) as count FROM memberships WHERE school_id = ? AND role = 'admin'")
      .get(req.params.schoolId);
    if (count <= 1) return res.status(400).json({ error: '無法移除最後一位管理者' });
  }

  const user = db.prepare('SELECT display_name FROM users WHERE id = ?').get(target.user_id);
  const roleLabel = { admin: '管理者', teacher: '教師', front_desk: '櫃台' }[target.role] || target.role;
  addToTrash(req.params.schoolId, 'membership', `${user?.display_name || '未知使用者'}（${roleLabel}）`, captureMembership(req.params.membershipId), req.user.id, {
    teacherId: target.teacher_id || null,
  });

  db.prepare('DELETE FROM memberships WHERE id = ?').run(req.params.membershipId);
  res.status(204).end();
});
