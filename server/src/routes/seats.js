import { Router } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';

export const seatsRouter = Router({ mergeParams: true });
seatsRouter.use(requireMembership());

function serialize(row) {
  const students = db
    .prepare(
      `SELECT s.id, s.name FROM seat_students ss JOIN students s ON s.id = ss.student_id WHERE ss.seat_assignment_id = ?`
    )
    .all(row.id);
  return { ...row, students };
}

seatsRouter.get('/', (req, res) => {
  const { date, time_slot } = req.query;
  if (!date || time_slot === undefined) {
    return res.status(400).json({ error: 'date and time_slot query params required' });
  }
  const rows = db
    .prepare('SELECT * FROM seat_assignments WHERE school_id = ? AND seat_date = ? AND time_slot = ?')
    .all(req.params.schoolId, date, time_slot);
  res.json(rows.map(serialize));
});

// 安排（新增或更新）某一桌：每桌最多 1 位教師、最多 2 位學生；同時段不可將同一位教師/學生排到別桌
seatsRouter.put('/:seatNumber', requireMembership(['admin', 'front_desk']), (req, res) => {
  const seatNumber = Number(req.params.seatNumber);
  if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > 13) {
    return res.status(400).json({ error: 'seat_number 必須介於 1-13' });
  }
  const { date, time_slot, teacher_id, student_ids } = req.body;
  if (!date || time_slot === undefined) {
    return res.status(400).json({ error: 'date and time_slot required' });
  }
  const students = student_ids || [];
  if (students.length > 2) return res.status(400).json({ error: '每桌最多兩名學生' });

  const otherSeatsSameSlot = db
    .prepare(
      `SELECT sa.seat_number, sa.teacher_id, s.student_id FROM seat_assignments sa
       LEFT JOIN seat_students s ON s.seat_assignment_id = sa.id
       WHERE sa.school_id = ? AND sa.seat_date = ? AND sa.time_slot = ? AND sa.seat_number != ?`
    )
    .all(req.params.schoolId, date, time_slot, seatNumber);

  if (teacher_id && otherSeatsSameSlot.some((r) => r.teacher_id === teacher_id)) {
    return res.status(400).json({ error: '該教師此時段已被安排在其他桌' });
  }
  for (const sid of students) {
    if (otherSeatsSameSlot.some((r) => r.student_id === sid)) {
      return res.status(400).json({ error: '該學生此時段已被安排在其他桌' });
    }
  }

  let row = db
    .prepare(
      'SELECT * FROM seat_assignments WHERE school_id = ? AND seat_date = ? AND time_slot = ? AND seat_number = ?'
    )
    .get(req.params.schoolId, date, time_slot, seatNumber);

  if (!row) {
    const id = nanoid();
    db.prepare(
      `INSERT INTO seat_assignments (id, school_id, seat_date, time_slot, seat_number, teacher_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, req.params.schoolId, date, time_slot, seatNumber, teacher_id || null);
    row = db.prepare('SELECT * FROM seat_assignments WHERE id = ?').get(id);
  } else {
    db.prepare('UPDATE seat_assignments SET teacher_id = ? WHERE id = ?').run(teacher_id || null, row.id);
  }

  db.prepare('DELETE FROM seat_students WHERE seat_assignment_id = ?').run(row.id);
  const insert = db.prepare('INSERT INTO seat_students (seat_assignment_id, student_id) VALUES (?, ?)');
  for (const sid of students) insert.run(row.id, sid);

  broadcastChange(req.params.schoolId, 'seats');
  res.json(serialize(db.prepare('SELECT * FROM seat_assignments WHERE id = ?').get(row.id)));
});

seatsRouter.delete('/:seatNumber', requireMembership(['admin', 'front_desk']), (req, res) => {
  const seatNumber = Number(req.params.seatNumber);
  const { date, time_slot } = req.query;
  if (!date || time_slot === undefined) {
    return res.status(400).json({ error: 'date and time_slot query params required' });
  }
  db.prepare(
    'DELETE FROM seat_assignments WHERE school_id = ? AND seat_date = ? AND time_slot = ? AND seat_number = ?'
  ).run(req.params.schoolId, date, time_slot, seatNumber);
  broadcastChange(req.params.schoolId, 'seats');
  res.status(204).end();
});
