import { nanoid } from 'nanoid';
import { auditLogsRepository } from '../repositories/index.js';

// category 決定屬於 Audit（誰在什麼時間改了什麼）還是 Diagnostic（錯誤/automation/整合狀態）分頁，
// 集中在這裡對應一次，UI 跟呼叫端都不用各自維護這份對照表
const AUDIT_CATEGORIES = new Set(['USER_ACTION', 'DATA_CHANGE', 'AUTH', 'SECURITY']);
const DIAGNOSTIC_CATEGORIES = new Set(['SYSTEM', 'ERROR', 'AUTOMATION', 'INTEGRATION']);

// 絕對不能被記錄進 log 的欄位名稱（不分大小寫），即使呼叫端不小心把整包 body 丟進 metadata 也會被濾掉
const SENSITIVE_KEYS = new Set([
  'password', 'admin_password', 'newpassword', 'new_password',
  'token', 'jwt', 'session', 'cookie', 'authorization',
  'secret', 'api_key', 'apikey', 'credit_card', 'card_number',
]);

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const cleaned = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) continue;
    cleaned[key] = value && typeof value === 'object' ? sanitizeMetadata(value) : value;
  }
  return cleaned;
}

// 主要業務操作完成後才呼叫，不放在 transaction 裡面：這裡失敗只 console.error，
// 絕不能讓 log 寫入失敗導致原本已經成功的 CRUD 操作變成 500（見 docs/LOGGING_ARCHITECTURE.md 的原則）。
// Admin unlock 這類 security-critical log 目前走一樣的 fire-and-forget 寫法——資料庫本身寫入失敗時
// 系統已經有更大的問題，不應該因為多加一層「log 失敗就擋登入」而製造新的 single point of failure。
export function logEvent({ level = 'INFO', category, pageKey = null, action, message, userId = null, schoolId = null, entityType = null, entityId = null, requestId = null, metadata = null }) {
  try {
    if (!category || !action || !message) {
      console.error('[auditLog] missing required field', { category, action, message });
      return;
    }
    const logType = AUDIT_CATEGORIES.has(category) ? 'audit' : DIAGNOSTIC_CATEGORIES.has(category) ? 'diagnostic' : null;
    if (!logType) {
      console.error('[auditLog] unknown category', category);
      return;
    }
    auditLogsRepository.append({
      id: nanoid(),
      logType,
      level,
      category,
      pageKey,
      action,
      message,
      userId,
      schoolId,
      entityType,
      entityId,
      requestId,
      metadataJson: metadata ? JSON.stringify(sanitizeMetadata(metadata)) : null,
    });
  } catch (err) {
    console.error('[auditLog] failed to write log (main operation NOT affected):', err.message);
  }
}

export function logInfo(fields) {
  logEvent({ ...fields, level: 'INFO' });
}

export function logWarning(fields) {
  logEvent({ ...fields, level: 'WARN' });
}

export function logError(fields) {
  logEvent({ ...fields, level: 'ERROR', category: fields.category || 'ERROR' });
}

export function findLogs(filters) {
  return auditLogsRepository.find(filters);
}
