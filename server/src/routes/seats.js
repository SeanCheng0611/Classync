import { Router } from 'express';
import { nanoid } from 'nanoid';
import { seatsRepository } from '../repositories/index.js';
import { requireMembership } from '../auth/middleware.js';
import { broadcastChange } from '../realtime/index.js';
import { logEvent } from '../services/auditLog.service.js';
import { PAGE_KEYS } from '../constants/pageKeys.js';

export const seatsRouter = Router({ mergeParams: true });
seatsRouter.use(requireMembership());

function serialize(row) {
  return { ...row, students: seatsRepository.findStudents(row.id) };
}

seatsRouter.get('/', (req, res) => {
  const { date, time_slot } = req.query;
  if (!date || time_slot === undefined) {
    return res.status(400).json({ error: 'date and time_slot query params required' });
  }
  const rows = seatsRepository.findByDateAndSlot(req.params.schoolId, date, time_slot);
  res.json(rows.map(serialize));
});

// 安排（新增或更新）某一桌：每桌最多 1 位教師、最多 2 位學生；同時段不可將同一位教師/學生排到別桌
seatsRouter.put('/:seatNumber', requireMembership(['admin', 'front_desk']), (req, res) => {
  const seatNumber = Number(req.params.seatNumber);
  if (!Number.isInteger(seatNumber) || seatNumber < 1) {
    return res.status(400).json({ error: 'seat_number 必須是正整數' });
  }
  const { date, time_slot, teacher_id, student_ids } = req.body;
  if (!date || time_slot === undefined) {
    return res.status(400).json({ error: 'date and time_slot required' });
  }
  const students = student_ids || [];
  if (students.length > 2) return res.status(400).json({ error: '每桌最多兩名學生' });

  const otherSeatsSameSlot = seatsRepository.findOtherSeatsSameSlot(req.params.schoolId, date, time_slot, seatNumber);

  if (teacher_id && otherSeatsSameSlot.some((r) => r.teacher_id === teacher_id)) {
    return res.status(400).json({ error: '該教師此時段已被安排在其他桌' });
  }
  for (const sid of students) {
    if (otherSeatsSameSlot.some((r) => r.student_id === sid)) {
      return res.status(400).json({ error: '該學生此時段已被安排在其他桌' });
    }
  }

  const existingRow = seatsRepository.findByDateSlotAndSeat(req.params.schoolId, date, time_slot, seatNumber);
  const id = existingRow?.id || nanoid();

  seatsRepository.upsertAssignment({
    id,
    schoolId: req.params.schoolId,
    date,
    timeSlot: time_slot,
    seatNumber,
    teacherId: teacher_id || null,
    students,
    isNew: !existingRow,
  });

  broadcastChange(req.params.schoolId, 'seats');
  logEvent({
    category: 'DATA_CHANGE', pageKey: PAGE_KEYS.SEATS, action: 'seat.update',
    message: `更新座位 #${seatNumber}（${date} ${time_slot}）`, userId: req.user.id, schoolId: req.params.schoolId,
    entityType: 'seat_assignment', entityId: id,
  });
  res.json(serialize(seatsRepository.findById(id)));
});

seatsRouter.delete('/:seatNumber', requireMembership(['admin', 'front_desk']), (req, res) => {
  const seatNumber = Number(req.params.seatNumber);
  const { date, time_slot } = req.query;
  if (!date || time_slot === undefined) {
    return res.status(400).json({ error: 'date and time_slot query params required' });
  }
  seatsRepository.deleteAssignment(req.params.schoolId, date, time_slot, seatNumber);
  broadcastChange(req.params.schoolId, 'seats');
  res.status(204).end();
});
