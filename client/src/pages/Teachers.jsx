import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { takeLastVisitedId, scrollRowIntoView } from '../lib/scrollAnchor';
import FlexibleScheduleEditor from '../components/FlexibleScheduleEditor';
import FlexibleScheduleSummary from '../components/FlexibleScheduleSummary';
import DuplicateConfirmModal from '../components/DuplicateConfirmModal';
import SubjectMultiSelect from '../components/SubjectMultiSelect';
import PillListSummary from '../components/PillListSummary';
import { useSubjectMapping } from '../hooks/useSubjectMapping';
import { parseSubjects } from '../lib/subjects';
import { saveWorkbookAs, applyExportStyle } from '../lib/excelExport';
import { todayStr, WEEKDAY_LABELS } from '../lib/time';
import {
  emptyFlexibleScheduleForm,
  flexibleScheduleToForm,
  flexibleScheduleFormToPayload,
  FLEXIBLE_SCHEDULE_WEEKDAYS,
} from '../lib/flexibleSchedule';

const emptyForm = {
  name: '',
  subjects: [],
  rate_grade_1_6: 0,
  rate_grade_7_9: 0,
  rate_grade_10_12: 0,
  rate_admin: 0,
  note: '',
  flexible_schedule: emptyFlexibleScheduleForm(),
};

// 把 Excel 儲存格內容轉成 "HH:MM"：使用者可能直接打時間字串，也可能被 Excel 自動格式化成時間序列值（一天的小數比例）
function parseExcelTime(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) {
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  }
  if (typeof value === 'number') {
    const totalMinutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  }
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
}

// 彈性上課時段欄位固定接在時薪-行政（索引 6）之後：依序星期一~六、星期日，每天各佔「開始」「結束」兩欄
function parseExcelFlexibleSchedule(row) {
  const payload = {};
  FLEXIBLE_SCHEDULE_WEEKDAYS.forEach((weekday, i) => {
    const startIdx = 7 + i * 2;
    const start = parseExcelTime(row?.[startIdx]);
    const end = parseExcelTime(row?.[startIdx + 1]);
    if (start && end && end > start) payload[weekday] = { start, end };
  });
  return payload;
}

export default function Teachers() {
  const { currentSchoolId, currentMembership, schoolSettings } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);
  const { createResolver: createSubjectResolver, modal: subjectMappingModal } = useSubjectMapping(currentSchoolId);

  const [teachers, setTeachers] = useState([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const fileInputRef = useRef(null);
  const formRef = useRef(null);
  const savedScrollY = useRef(0);

  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  const [dupModal, setDupModal] = useState(null);
  const dupResolverRef = useRef(null);

  const askDuplicate = (newFields, existingFields, showBulkActions) =>
    new Promise((resolve) => {
      dupResolverRef.current = resolve;
      setDupModal({ newFields, existingFields, showBulkActions });
    });

  const resolveDup = (answer) => {
    setDupModal(null);
    dupResolverRef.current?.(answer);
    dupResolverRef.current = null;
  };

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    setTeachers(await api.get(`/api/schools/${currentSchoolId}/teachers`));
  }, [currentSchoolId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'teachers') load();
    });
  }, [currentSchoolId, load]);

  // 從教師詳細頁按返回時，把剛剛看的那位教師捲到列表最上面，而不是回復捲動高度
  useEffect(() => {
    if (teachers.length === 0) return;
    const id = takeLastVisitedId('/teachers');
    if (!id) return;
    scrollRowIntoView(`row-teacher-${id}`);
  }, [teachers]);

  const startEdit = (teacher) => {
    setError('');
    savedScrollY.current = window.scrollY;
    if (teacher) {
      setForm({
        name: teacher.name,
        subjects: teacher.subjects || [],
        rate_grade_1_6: teacher.rate_grade_1_6,
        rate_grade_7_9: teacher.rate_grade_7_9,
        rate_grade_10_12: teacher.rate_grade_10_12,
        rate_admin: teacher.rate_admin,
        note: teacher.note || '',
        flexible_schedule: flexibleScheduleToForm(teacher.flexible_schedule),
      });
      setEditing(teacher);
    } else {
      setForm(emptyForm);
      setEditing({});
    }
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(emptyForm);
    requestAnimationFrame(() => window.scrollTo({ top: savedScrollY.current, behavior: 'smooth' }));
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    const name = form.name.trim();
    const subjectsList = form.subjects;

    if (!editing?.id) {
      const existing = teachers.find((t) => t.name === name);
      if (existing) {
        const answer = await askDuplicate(
          [
            { label: '姓名', value: name },
            { label: '科目', value: subjectsList.join(', ') || '-' },
          ],
          [
            { label: '姓名', value: existing.name },
            { label: '科目', value: existing.subjects.join(', ') || '-' },
          ],
          false
        );
        if (answer === 'no') return;
      }
    }

    const payload = {
      name,
      subjects: subjectsList,
      rate_grade_1_6: Number(form.rate_grade_1_6) || 0,
      rate_grade_7_9: Number(form.rate_grade_7_9) || 0,
      rate_grade_10_12: Number(form.rate_grade_10_12) || 0,
      rate_admin: Number(form.rate_admin) || 0,
      note: form.note.trim() || null,
      flexible_schedule: flexibleScheduleFormToPayload(form.flexible_schedule),
    };
    try {
      if (editing?.id) {
        await api.put(`/api/schools/${currentSchoolId}/teachers/${editing.id}`, payload);
      } else {
        await api.post(`/api/schools/${currentSchoolId}/teachers`, payload);
      }
      cancelEdit();
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleDeleteMode = () => {
    setDeleteMode((v) => !v);
    setSelectedIds(new Set());
  };

  const toggleSelect = (teacherId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(teacherId)) next.delete(teacherId);
      else next.add(teacherId);
      return next;
    });
  };

  const selectAllVisible = () => setSelectedIds(new Set(filteredTeachers.map((t) => t.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const deleteTeachers = async (ids) => {
    setError('');
    try {
      await Promise.all(ids.map((teacherId) => api.del(`/api/schools/${currentSchoolId}/teachers/${teacherId}`)));
      setSelectedIds(new Set());
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`確定要刪除選取的 ${selectedIds.size} 位教師嗎？可從回收桶復原。`)) return;
    await deleteTeachers([...selectedIds]);
  };

  const deleteAllVisible = async () => {
    if (filteredTeachers.length === 0) return;
    if (!confirm(`確定要刪除目前顯示的全部 ${filteredTeachers.length} 位教師嗎？可從回收桶復原。`)) return;
    await deleteTeachers(filteredTeachers.map((t) => t.id));
  };

  // 匯入 Excel：檔名須包含「教師」才視為教師名單（不再看儲存格內容判斷）；第一列為標題，從第二列開始讀取，
  // 欄位固定為 編號(忽略)/姓名/科目/時薪-1~6年級/時薪-7~9年級/時薪-10~12年級/時薪-行政，
  // 後面固定接 14 欄彈性上課時段：星期一開始/星期一結束/.../星期六開始/星期六結束/星期日開始/星期日結束；
  // 時薪欄位空白視為 0；姓名跟既有教師或這次匯入中前面已接受的列重複時，跳出視窗一筆一筆確認
  const importExcel = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.name.includes('教師')) {
      setError('匯入失敗：檔案類型錯誤，請確認上傳的是教師名單（檔名須包含「教師」）。');
      return;
    }

    setError('');
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      let created = 0;
      let skipped = 0;
      const failedRows = [];
      const invalidRows = [];
      const existingByName = new Map(teachers.map((t) => [t.name, t]));
      const acceptedInBatch = new Map();
      let bulkDecision = null;
      const resolveSubjectToken = createSubjectResolver(parseSubjects(schoolSettings));

      for (const [idx, row] of rows.slice(1).entries()) {
        const name = row?.[1] != null ? String(row[1]).trim() : '';
        const subjectsText = row?.[2] != null ? String(row[2]).trim() : '';
        const rate16 = row?.[3] != null && String(row[3]).trim() !== '' ? Number(row[3]) : 0;
        const rate79 = row?.[4] != null && String(row[4]).trim() !== '' ? Number(row[4]) : 0;
        const rate1012 = row?.[5] != null && String(row[5]).trim() !== '' ? Number(row[5]) : 0;
        const rateAdmin = row?.[6] != null && String(row[6]).trim() !== '' ? Number(row[6]) : 0;
        const isBlankRow = !name && !subjectsText;
        if (isBlankRow) continue;
        if (!name) {
          skipped++;
          invalidRows.push(`第 ${idx + 2} 列（缺姓名）`);
          continue;
        }

        const rawSubjectTokens = subjectsText.split(/[,、\s]+/).map((s) => s.trim()).filter(Boolean);
        const subjectsList = [];
        for (const raw of rawSubjectTokens) {
          const code = await resolveSubjectToken(raw);
          if (code && !subjectsList.includes(code)) subjectsList.push(code);
        }
        const existingMatch = existingByName.get(name) || acceptedInBatch.get(name);
        if (existingMatch) {
          let decision;
          if (bulkDecision) {
            decision = bulkDecision;
          } else {
            const answer = await askDuplicate(
              [
                { label: '姓名', value: name },
                { label: '科目', value: subjectsList.join(', ') || '-' },
              ],
              [
                { label: '姓名', value: existingMatch.name },
                { label: '科目', value: (existingMatch.subjects || []).join(', ') || '-' },
              ],
              true
            );
            if (answer === 'all-yes') {
              bulkDecision = 'yes';
              decision = 'yes';
            } else if (answer === 'all-no') {
              bulkDecision = 'no';
              decision = 'no';
            } else {
              decision = answer;
            }
          }
          if (decision === 'no') {
            skipped++;
            continue;
          }
        }

        try {
          await api.post(`/api/schools/${currentSchoolId}/teachers`, {
            name,
            subjects: subjectsList,
            rate_grade_1_6: rate16,
            rate_grade_7_9: rate79,
            rate_grade_10_12: rate1012,
            rate_admin: rateAdmin,
            flexible_schedule: parseExcelFlexibleSchedule(row),
          });
          created++;
          acceptedInBatch.set(name, { name, subjects: subjectsList });
        } catch (err) {
          skipped++;
          failedRows.push(`${name}：${err.message}`);
        }
      }
      load();
      let summary = `匯入完成：新增 ${created} 位，略過 ${skipped} 位`;
      if (invalidRows.length > 0) summary += `\n\n以下列缺姓名，未匯入：\n${invalidRows.join('\n')}`;
      if (failedRows.length > 0) summary += `\n\n未匯入的列：\n${failedRows.join('\n')}`;
      alert(summary);
    } catch (err) {
      setError('讀取 Excel 檔案失敗：' + err.message);
    } finally {
      setImporting(false);
    }
  };

  // 編號＝依新增順序（後端已排序）從 1 編起，純顯示用；用完整列表算好再過濾，搜尋時編號才不會跟著變動
  const numberedTeachers = teachers.map((t, idx) => ({ ...t, displayNo: idx + 1 }));
  const filteredTeachers = numberedTeachers.filter((t) => t.name.includes(search.trim()));

  // 匯出目前列表（有搜尋就只匯出篩選後的結果）
  const exportExcel = async () => {
    setError('');
    setExporting(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('教師檔案');
      const flexibleColumns = FLEXIBLE_SCHEDULE_WEEKDAYS.flatMap((w) => [
        { header: `星期${WEEKDAY_LABELS[w]}開始`, key: `flex_${w}_start`, width: 12 },
        { header: `星期${WEEKDAY_LABELS[w]}結束`, key: `flex_${w}_end`, width: 12 },
      ]);
      sheet.columns = [
        { header: '編號', key: 'no', width: 8 },
        { header: '姓名', key: 'name', width: 14 },
        { header: '科目', key: 'subjects', width: 16 },
        { header: '時薪(1-6)', key: 'rate16', width: 10 },
        { header: '時薪(7-9)', key: 'rate79', width: 10 },
        { header: '時薪(10-12)', key: 'rate1012', width: 10 },
        { header: '時薪(行政)', key: 'rateAdmin', width: 10 },
        ...flexibleColumns,
        { header: '備註', key: 'note', width: 20 },
      ];
      for (const t of filteredTeachers) {
        const row = {
          no: t.displayNo,
          name: t.name,
          subjects: t.subjects.join(', '),
          rate16: t.rate_grade_1_6,
          rate79: t.rate_grade_7_9,
          rate1012: t.rate_grade_10_12,
          rateAdmin: t.rate_admin,
          note: t.note,
        };
        for (const w of FLEXIBLE_SCHEDULE_WEEKDAYS) {
          row[`flex_${w}_start`] = t.flexible_schedule?.[w]?.start || '';
          row[`flex_${w}_end`] = t.flexible_schedule?.[w]?.end || '';
        }
        sheet.addRow(row);
      }
      applyExportStyle(sheet);
      await saveWorkbookAs(workbook, `教師檔案 ${todayStr()}.xlsx`);
    } catch (err) {
      setError('匯出失敗：' + err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>教師檔案</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                style={{ display: 'none' }}
                onChange={importExcel}
              />
              <button disabled={importing} onClick={() => fileInputRef.current?.click()}>
                {importing ? '匯入中...' : '匯入 Excel'}
              </button>
              <button disabled={exporting} onClick={exportExcel}>
                {exporting ? '匯出中...' : '匯出 Excel'}
              </button>
              <button onClick={() => startEdit(null)}>+ 新增教師</button>
            </>
          )}
          {isAdmin && (
            <button type="button" onClick={toggleDeleteMode}>
              {deleteMode ? '結束刪除模式' : '刪除'}
            </button>
          )}
          {currentMembership?.role === 'admin' && (
            <Link to="/teachers/trash"><button type="button">回收桶</button></Link>
          )}
        </div>
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <input
        type="text"
        placeholder="搜尋姓名..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginTop: 12, maxWidth: 240 }}
      />

      {deleteMode && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button type="button" onClick={selectAllVisible}>全選</button>
          <button type="button" onClick={clearSelection}>取消全選</button>
          <button type="button" onClick={bulkDelete} disabled={selectedIds.size === 0} style={{ color: 'var(--danger)' }}>
            刪除選取項目（{selectedIds.size}）
          </button>
          <button type="button" onClick={deleteAllVisible} style={{ color: 'var(--danger)' }}>
            全部刪除（{filteredTeachers.length}）
          </button>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            {deleteMode && <th></th>}
            <th>編號</th>
            <th>姓名</th>
            <th>科目</th>
            <th>時薪(1-6)</th>
            <th>時薪(7-9)</th>
            <th>時薪(10-12)</th>
            <th>時薪(行政)</th>
            <th>彈性上課時段</th>
            <th>備註</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filteredTeachers.map((t) => (
            <tr
              key={t.id}
              id={`row-teacher-${t.id}`}
              style={{
                borderBottom: '1px solid var(--border)',
                background: deleteMode && selectedIds.has(t.id) ? 'var(--danger-soft, #fdecea)' : 'transparent',
              }}
            >
              {deleteMode && (
                <td><input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => toggleSelect(t.id)} /></td>
              )}
              <td>{t.displayNo}</td>
              <td><Link to={`/teachers/${t.id}`}>{t.name}</Link></td>
              <td>
                <PillListSummary
                  entries={(t.subjects || []).map((subj) => ({ key: subj, label: subj }))}
                  maxWidth={130}
                  emptyText="無科目"
                />
              </td>
              <td>{t.rate_grade_1_6}</td>
              <td>{t.rate_grade_7_9}</td>
              <td>{t.rate_grade_10_12}</td>
              <td>{t.rate_admin}</td>
              <td><FlexibleScheduleSummary schedule={t.flexible_schedule} /></td>
              <td>{t.note}</td>
              <td>
                {isAdmin && !deleteMode && <button onClick={() => startEdit(t)}>編輯</button>}
              </td>
            </tr>
          ))}
          {filteredTeachers.length === 0 && (
            <tr>
              <td colSpan={deleteMode ? 11 : 10} style={{ color: 'var(--text-muted)', padding: 12 }}>
                {teachers.length === 0 ? '尚無教師資料' : '查無符合的教師'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <form ref={formRef} onSubmit={save} style={{ marginTop: 24, maxWidth: 420, display: 'grid', gap: 8 }}>
          <h3>{editing.id ? '編輯教師' : '新增教師'}</h3>
          <label>
            姓名
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            科目
            <SubjectMultiSelect value={form.subjects} onChange={(next) => setForm({ ...form, subjects: next })} />
          </label>
          <label>
            時薪 - 1~6年級
            <input
              type="number"
              value={form.rate_grade_1_6}
              onChange={(e) => setForm({ ...form, rate_grade_1_6: e.target.value })}
            />
          </label>
          <label>
            時薪 - 7~9年級
            <input
              type="number"
              value={form.rate_grade_7_9}
              onChange={(e) => setForm({ ...form, rate_grade_7_9: e.target.value })}
            />
          </label>
          <label>
            時薪 - 10~12年級
            <input
              type="number"
              value={form.rate_grade_10_12}
              onChange={(e) => setForm({ ...form, rate_grade_10_12: e.target.value })}
            />
          </label>
          <label>
            時薪 - 行政
            <input
              type="number"
              value={form.rate_admin}
              onChange={(e) => setForm({ ...form, rate_admin: e.target.value })}
            />
          </label>
          <div>
            <FlexibleScheduleEditor
              value={form.flexible_schedule}
              onChange={(next) => setForm({ ...form, flexible_schedule: next })}
            />
          </div>
          <label>
            備註
            <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <div>
            <button type="submit">儲存</button> <button type="button" onClick={cancelEdit}>取消</button>
          </div>
        </form>
      )}

      <button
        type="button"
        title="回到頂端"
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        style={{
          position: 'fixed',
          right: 24,
          bottom: 24,
          width: 46,
          height: 46,
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '50%',
          background: 'var(--accent)',
          color: '#fff',
          borderColor: 'var(--accent)',
          fontSize: 20,
          lineHeight: 1,
          boxShadow: 'var(--shadow)',
          zIndex: 10,
        }}
      >
        ↑
      </button>

      {dupModal && (
        <DuplicateConfirmModal
          title="發現同名教師"
          newFields={dupModal.newFields}
          existingFields={dupModal.existingFields}
          showBulkActions={dupModal.showBulkActions}
          onDecide={(accept) => resolveDup(accept ? 'yes' : 'no')}
          onDecideAll={(accept) => resolveDup(accept ? 'all-yes' : 'all-no')}
        />
      )}
      {subjectMappingModal}
    </div>
  );
}
