import { db, runInTransaction } from '../db/index.js';

// 座位是「日期＋時段＋桌號」獨立存在的版面資料，不綁定特定 class_sessions（沒有 session_id 外鍵）
export const seatsRepository = {
  findByDateAndSlot(schoolId, date, timeSlot) {
    return db.prepare('SELECT * FROM seat_assignments WHERE school_id = ? AND seat_date = ? AND time_slot = ?').all(schoolId, date, timeSlot);
  },

  findByDateSlotAndSeat(schoolId, date, timeSlot, seatNumber) {
    return db
      .prepare('SELECT * FROM seat_assignments WHERE school_id = ? AND seat_date = ? AND time_slot = ? AND seat_number = ?')
      .get(schoolId, date, timeSlot, seatNumber);
  },

  findById(id) {
    return db.prepare('SELECT * FROM seat_assignments WHERE id = ?').get(id);
  },

  // 同時段其他桌的教師/學生佔用狀況，用來檢查衝堂
  findOtherSeatsSameSlot(schoolId, date, timeSlot, excludeSeatNumber) {
    return db
      .prepare(
        `SELECT sa.seat_number, sa.teacher_id, s.student_id FROM seat_assignments sa
         LEFT JOIN seat_students s ON s.seat_assignment_id = sa.id
         WHERE sa.school_id = ? AND sa.seat_date = ? AND sa.time_slot = ? AND sa.seat_number != ?`
      )
      .all(schoolId, date, timeSlot, excludeSeatNumber);
  },

  findStudents(seatAssignmentId) {
    return db
      .prepare(`SELECT s.id, s.name FROM seat_students ss JOIN students s ON s.id = ss.student_id WHERE ss.seat_assignment_id = ?`)
      .all(seatAssignmentId);
  },

  // 新增或更新一桌（含教師）+ 取代學生名單，整組 atomic
  upsertAssignment({ id, schoolId, date, timeSlot, seatNumber, teacherId, students, isNew }) {
    runInTransaction(() => {
      if (isNew) {
        db.prepare(
          `INSERT INTO seat_assignments (id, school_id, seat_date, time_slot, seat_number, teacher_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(id, schoolId, date, timeSlot, seatNumber, teacherId);
      } else {
        db.prepare('UPDATE seat_assignments SET teacher_id = ? WHERE id = ?').run(teacherId, id);
      }
      db.prepare('DELETE FROM seat_students WHERE seat_assignment_id = ?').run(id);
      const insert = db.prepare('INSERT INTO seat_students (seat_assignment_id, student_id) VALUES (?, ?)');
      for (const studentId of students) insert.run(id, studentId);
    });
  },

  deleteAssignment(schoolId, date, timeSlot, seatNumber) {
    db.prepare('DELETE FROM seat_assignments WHERE school_id = ? AND seat_date = ? AND time_slot = ? AND seat_number = ?').run(
      schoolId,
      date,
      timeSlot,
      seatNumber
    );
  },
};
