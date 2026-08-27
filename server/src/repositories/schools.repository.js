import { db } from '../db/index.js';

export const schoolsRepository = {
  findById(id) {
    return db.prepare('SELECT * FROM schools WHERE id = ?').get(id);
  },

  // 該使用者是成員的所有補習班，附帶在該補習班的角色
  findForUser(userId) {
    return db
      .prepare(
        `SELECT s.id, s.name, m.role
         FROM memberships m JOIN schools s ON s.id = m.school_id
         WHERE m.user_id = ?`
      )
      .all(userId);
  },

  create({ id, name, inviteCode }) {
    db.prepare('INSERT INTO schools (id, name, invite_code) VALUES (?, ?, ?)').run(id, name, inviteCode);
  },

  updateTuitionDefaults(id, { grade1to6, grade7to9, grade10to12 }) {
    db.prepare(
      `UPDATE schools SET default_price_grade_1_6 = ?, default_price_grade_7_9 = ?, default_price_grade_10_12 = ? WHERE id = ?`
    ).run(grade1to6, grade7to9, grade10to12, id);
  },

  updateSchedulingSettings(id, { groupClassMaxStudents, timePickerRangeStart, timePickerRangeEnd, defaultScheduleSpanMonths, defaultClassDurationHours }) {
    db.prepare(
      `UPDATE schools SET group_class_max_students = ?, time_picker_range_start = ?, time_picker_range_end = ?, default_schedule_span_months = ?, default_class_duration_hours = ?
       WHERE id = ?`
    ).run(groupClassMaxStudents, timePickerRangeStart, timePickerRangeEnd, defaultScheduleSpanMonths, defaultClassDurationHours, id);
  },

  updateSubjects(id, subjects) {
    db.prepare('UPDATE schools SET subjects = ? WHERE id = ?').run(JSON.stringify(subjects), id);
  },

  updateTypeColors(id, typeColors) {
    db.prepare('UPDATE schools SET type_colors = ? WHERE id = ?').run(JSON.stringify(typeColors), id);
  },

  updateScheduleTypeOrder(id, order) {
    db.prepare('UPDATE schools SET schedule_type_order = ? WHERE id = ?').run(JSON.stringify(order), id);
  },

  updateAttendanceTypeOrder(id, order) {
    db.prepare('UPDATE schools SET attendance_type_order = ? WHERE id = ?').run(JSON.stringify(order), id);
  },

  updateSettingsSectionOrder(id, order) {
    db.prepare('UPDATE schools SET settings_section_order = ? WHERE id = ?').run(JSON.stringify(order), id);
  },

  updateSeatLayout(id, layout) {
    db.prepare('UPDATE schools SET seat_layout = ? WHERE id = ?').run(JSON.stringify(layout), id);
  },

  delete(id) {
    db.prepare('DELETE FROM schools WHERE id = ?').run(id);
  },
};
