import { nanoid } from 'nanoid';
import { attendanceRepository, schedulingRepository, runInTransaction } from '../repositories/index.js';

// 新增或更新一筆點名紀錄（依 session_id + person_type + person_id upsert）
export function setAttendance({ schoolId, sessionId, personType, personId, status, makeupArranged, note }) {
  const existing = attendanceRepository.findOne(sessionId, personType, personId);

  if (existing) {
    // 取消安排調課時一併清掉 makeup_session_id，避免殘留指向已無關聯的調課課堂
    const makeupSessionId = makeupArranged ? existing.makeup_session_id : null;
    attendanceRepository.update(existing.id, { status, makeupArranged, makeupSessionId, note });
  } else {
    attendanceRepository.create({
      id: nanoid(),
      schoolId,
      sessionId,
      personType,
      personId,
      status,
      makeupArranged,
      note,
    });
  }

  const record = attendanceRepository.findOne(sessionId, personType, personId);
  return { record, wasUpdate: !!existing };
}

// 撤銷一筆點名紀錄：若已排定調課課堂，一併取消/刪除該調課課堂，整組 atomic。
// 這是橫跨 attendance 與 scheduling 兩個 repository 的 business operation，orchestration 屬於 service 責任，
// route 只需要呼叫這一個函式，不需要知道要一起改哪些 repository、也不需要自己管 transaction。
export function revokeAttendance({ sessionId, personType, personId }) {
  const record = attendanceRepository.findOne(sessionId, personType, personId);
  if (!record) return null;

  let makeupCancelled = false;
  runInTransaction(() => {
    if (record.makeup_session_id) {
      const makeupSession = schedulingRepository.findSessionByIdAny(record.makeup_session_id);
      if (makeupSession) {
        if (makeupSession.type === 'regular') {
          schedulingRepository.cancelSession(makeupSession.id);
        } else {
          schedulingRepository.deleteSession(makeupSession.id);
        }
        makeupCancelled = true;
      }
    }
    attendanceRepository.delete(record.id);
  });

  return { record, makeupCancelled };
}
