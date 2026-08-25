import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import { takeLastVisitedId, scrollRowIntoView } from '../lib/scrollAnchor';
import DuplicateConfirmModal from '../components/DuplicateConfirmModal';
import FixedClassSummary from '../components/FixedClassSummary';
import PillListSummary from '../components/PillListSummary';
import SubjectMultiSelect from '../components/SubjectMultiSelect';
import { saveWorkbookAs, applyExportStyle } from '../lib/excelExport';
import { todayStr, WEEKDAY_LABELS, slotRangeLabel } from '../lib/time';
import { useSubjectMapping } from '../hooks/useSubjectMapping';
import { parseSubjects } from '../lib/subjects';

const GRADES = Array.from({ length: 12 }, (_, i) => i + 1);

const emptyForm = { name: '', grade: 1, school_name: '', subjects: [], status: 'active', note: '' };

export default function Students() {
  const { currentSchoolId, currentMembership, schoolSettings } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);
  const isStrictAdmin = currentMembership?.role === 'admin';
  const { createResolver: createSubjectResolver, modal: subjectMappingModal } = useSubjectMapping(currentSchoolId);

  const [students, setStudents] = useState([]);
  const [templates, setTemplates] = useState([]);
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

  // 跳出同名確認視窗，等使用者選擇後才繼續（yes/no 這一筆，all-yes/all-no 套用到後續全部）
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
    const [st, tpl] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/students`),
      api.get(`/api/schools/${currentSchoolId}/schedule-templates`),
    ]);
    setStudents(st);
    setTemplates(tpl);
  }, [currentSchoolId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'students' || resource === 'schedule') load();
    });
  }, [currentSchoolId, load]);

  // 從學生詳細頁按返回時，把剛剛看的那位學生捲到列表最上面，而不是回復捲動高度
  useEffect(() => {
    if (students.length === 0) return;
    const id = takeLastVisitedId('/students');
    if (!id) return;
    scrollRowIntoView(`row-student-${id}`);
  }, [students]);

  const startEdit = (student) => {
    setError('');
    savedScrollY.current = window.scrollY;
    if (student) {
      setForm({
        name: student.name,
        grade: student.grade,
        school_name: student.school_name || '',
        subjects: student.subjects || [],
        status: student.status,
        note: student.note || '',
      });
      setEditing(student);
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

    if (!editing?.id) {
      const existing = students.find((s) => s.name === name);
      if (existing) {
        const answer = await askDuplicate(
          [
            { label: '姓名', value: name },
            { label: '學校', value: form.school_name.trim() || '-' },
            { label: '年級', value: form.grade },
          ],
          [
            { label: '姓名', value: existing.name },
            { label: '學校', value: existing.school_name || '-' },
            { label: '年級', value: existing.grade },
          ],
          false
        );
        if (answer === 'no') return;
      }
    }

    const payload = {
      name,
      grade: Number(form.grade),
      school_name: form.school_name.trim() || null,
      subjects: form.subjects,
      status: form.status,
      note: form.note.trim() || null,
    };
    try {
      if (editing?.id) {
        await api.put(`/api/schools/${currentSchoolId}/students/${editing.id}`, payload);
      } else {
        await api.post(`/api/schools/${currentSchoolId}/students`, payload);
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

  const toggleSelect = (studentId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  };

  const selectAllVisible = () => setSelectedIds(new Set(filteredStudents.map((s) => s.id)));
  const clearSelection = () => setSelectedIds(new Set());

  const deleteStudents = async (ids) => {
    setError('');
    try {
      await Promise.all(ids.map((studentId) => api.del(`/api/schools/${currentSchoolId}/students/${studentId}`)));
      setSelectedIds(new Set());
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const bulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`確定要刪除選取的 ${selectedIds.size} 位學生嗎？可從回收桶復原。`)) return;
    await deleteStudents([...selectedIds]);
  };

  const deleteAllVisible = async () => {
    if (filteredStudents.length === 0) return;
    if (!confirm(`確定要刪除目前顯示的全部 ${filteredStudents.length} 位學生嗎？可從回收桶復原。`)) return;
    await deleteStudents(filteredStudents.map((s) => s.id));
  };

  // 匯入 Excel：檔名須包含「學生」才視為學生名單（不再看儲存格內容判斷）；第一列為標題，從第二列開始逐列讀取，
  // 欄位固定為 編號(忽略)/姓名/年級/學校/科目（以空白分隔多筆）/固定課(忽略，是排課資料不透過匯入設定)/狀態/備註；
  // 姓名跟既有學生或這次匯入中前面已接受的列重複時，會跳出視窗一筆一筆確認是否仍要新增
  const importExcel = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.name.includes('學生')) {
      setError('匯入失敗：檔案類型錯誤，請確認上傳的是學生名單（檔名須包含「學生」）。');
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
      const existingByName = new Map(students.map((s) => [s.name, s]));
      const acceptedInBatch = new Map();
      let bulkDecision = null;
      const resolveSubjectToken = createSubjectResolver(parseSubjects(schoolSettings));

      for (const [idx, row] of rows.slice(1).entries()) {
        const name = row?.[1] != null ? String(row[1]).trim() : '';
        const gradeRaw = row?.[2];
        const grade = Number(gradeRaw);
        const schoolName = row?.[3] != null ? String(row[3]).trim() : '';
        const subjectsText = row?.[4] != null ? String(row[4]).trim() : '';
        // 欄位 F（索引 5）是固定課摘要，匯入時忽略
        const statusText = row?.[6] != null ? String(row[6]).trim() : '';
        const note = row?.[7] != null ? String(row[7]).trim() : '';
        const status = statusText === '停用' ? 'inactive' : 'active';
        const isBlankRow = !name && (gradeRaw == null || String(gradeRaw).trim() === '') && !schoolName;
        if (isBlankRow) continue;
        if (!name || !grade) {
          skipped++;
          invalidRows.push(name ? `第 ${idx + 2} 列「${name}」（年級格式錯誤）` : `第 ${idx + 2} 列（缺姓名）`);
          continue;
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
                { label: '學校', value: schoolName || '-' },
                { label: '年級', value: grade },
              ],
              [
                { label: '姓名', value: existingMatch.name },
                { label: '學校', value: existingMatch.school_name || '-' },
                { label: '年級', value: existingMatch.grade },
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

        const rawSubjectTokens = subjectsText.split(/[,、\s]+/).map((s) => s.trim()).filter(Boolean);
        const subjectsList = [];
        for (const raw of rawSubjectTokens) {
          const code = await resolveSubjectToken(raw);
          if (code && !subjectsList.includes(code)) subjectsList.push(code);
        }

        try {
          await api.post(`/api/schools/${currentSchoolId}/students`, {
            name,
            grade,
            school_name: schoolName || null,
            subjects: subjectsList,
            status,
            note: note || null,
          });
          created++;
          acceptedInBatch.set(name, { name, grade, school_name: schoolName });
        } catch (err) {
          skipped++;
          failedRows.push(`${name}：${err.message}`);
        }
      }
      load();
      let summary = `匯入完成：新增 ${created} 位，略過 ${skipped} 位`;
      if (invalidRows.length > 0) {
        summary += `\n\n以下列缺姓名或年級格式錯誤，未匯入：\n${invalidRows.join('\n')}`;
      }
      if (failedRows.length > 0) {
        summary += `\n\n未匯入的列：\n${failedRows.join('\n')}`;
      }
      alert(summary);
    } catch (err) {
      setError('讀取 Excel 檔案失敗：' + err.message);
    } finally {
      setImporting(false);
    }
  };

  // 該學生目前仍生效中的固定課（今天落在 active_from ~ active_until 之間）
  const activeTemplatesFor = (studentId) => {
    const today = todayStr();
    return templates.filter(
      (t) =>
        t.student_ids.includes(studentId) &&
        t.active_from <= today &&
        (!t.active_until || t.active_until >= today)
    );
  };

  // 編號＝依新增順序（後端已排序）從 1 編起，純顯示用；用完整列表算好再過濾，搜尋時編號才不會跟著變動
  const numberedStudents = students.map((s, idx) => ({ ...s, displayNo: idx + 1 }));
  const filteredStudents = numberedStudents.filter((s) => s.name.includes(search.trim()));

  // 匯出目前列表（有搜尋就只匯出篩選後的結果）
  const exportExcel = async () => {
    setError('');
    setExporting(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('學生檔案');
      sheet.columns = [
        { header: '編號', key: 'no', width: 8 },
        { header: '姓名', key: 'name', width: 14 },
        { header: '年級', key: 'grade', width: 8 },
        { header: '學校', key: 'school', width: 16 },
        { header: '科目', key: 'subjects', width: 20 },
        { header: '固定課', key: 'fixed', width: 40 },
        { header: '狀態', key: 'status', width: 10 },
        { header: '備註', key: 'note', width: 20 },
      ];
      for (const s of filteredStudents) {
        const fixed = activeTemplatesFor(s.id)
          .slice()
          .sort((a, b) => a.weekday - b.weekday || a.start_slot - b.start_slot)
          .map((t) => `星期${WEEKDAY_LABELS[t.weekday]} ${slotRangeLabel(t.start_slot, t.duration_slots)} ${t.subject}`)
          .join('、');
        sheet.addRow({
          no: s.displayNo,
          name: s.name,
          grade: s.grade,
          school: s.school_name,
          subjects: (s.subjects || []).join(', '),
          fixed,
          status: s.status === 'active' ? '在學' : '停用',
          note: s.note,
        });
      }
      applyExportStyle(sheet);
      await saveWorkbookAs(workbook, `學生檔案 ${todayStr()}.xlsx`);
    } catch (err) {
      setError('匯出失敗：' + err.message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>學生檔案</h2>
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
              <button onClick={() => startEdit(null)}>+ 新增學生</button>
            </>
          )}
          {isAdmin && (
            <button type="button" onClick={toggleDeleteMode}>
              {deleteMode ? '結束刪除模式' : '刪除'}
            </button>
          )}
          {isStrictAdmin && <Link to="/students/trash"><button type="button">回收桶</button></Link>}
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
            全部刪除（{filteredStudents.length}）
          </button>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, tableLayout: 'fixed' }}>
        <colgroup>
          {deleteMode && <col style={{ width: 32 }} />}
          <col style={{ width: 60 }} />
          <col style={{ width: 100 }} />
          <col style={{ width: 60 }} />
          <col style={{ width: 100 }} />
          <col style={{ width: 130 }} />
          <col style={{ width: 300 }} />
          <col />
          <col style={{ width: 70 }} />
          <col style={{ width: 80 }} />
        </colgroup>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            {deleteMode && <th></th>}
            <th>編號</th>
            <th>姓名</th>
            <th>年級</th>
            <th>學校</th>
            <th>科目</th>
            <th>固定課</th>
            <th>備註</th>
            <th>狀態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filteredStudents.map((s) => (
            <tr
              key={s.id}
              id={`row-student-${s.id}`}
              style={{
                borderBottom: '1px solid var(--border)',
                background: deleteMode && selectedIds.has(s.id) ? 'var(--danger-soft, #fdecea)' : 'transparent',
              }}
            >
              {deleteMode && (
                <td><input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleSelect(s.id)} /></td>
              )}
              <td>{s.displayNo}</td>
              <td><Link to={`/students/${s.id}`}>{s.name}</Link></td>
              <td>{s.grade}</td>
              <td>{s.school_name}</td>
              <td>
                <PillListSummary
                  entries={(s.subjects || []).map((subj) => ({ key: subj, label: subj }))}
                  maxWidth={130}
                  emptyText="無科目"
                />
              </td>
              <td><FixedClassSummary templates={activeTemplatesFor(s.id)} /></td>
              <td>{s.note}</td>
              <td>{s.status === 'active' ? '在學' : '停用'}</td>
              <td>
                {isAdmin && !deleteMode && <button onClick={() => startEdit(s)}>編輯</button>}
              </td>
            </tr>
          ))}
          {filteredStudents.length === 0 && (
            <tr>
              <td colSpan={deleteMode ? 10 : 9} style={{ color: 'var(--text-muted)', padding: 12 }}>
                {students.length === 0 ? '尚無學生資料' : '查無符合的學生'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <form ref={formRef} onSubmit={save} style={{ marginTop: 24, maxWidth: 360, display: 'grid', gap: 8 }}>
          <h3>{editing.id ? '編輯學生' : '新增學生'}</h3>
          <label>
            姓名
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            年級
            <select value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })}>
              {GRADES.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </label>
          <label>
            就讀學校
            <input value={form.school_name} onChange={(e) => setForm({ ...form, school_name: e.target.value })} />
          </label>
          <label>
            科目
            <SubjectMultiSelect value={form.subjects} onChange={(next) => setForm({ ...form, subjects: next })} />
          </label>
          {editing.id && (
            <label>
              狀態
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="active">在學</option>
                <option value="inactive">停用</option>
              </select>
            </label>
          )}
          <label>
            備註
            <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <div>
            <button type="submit">{editing.id ? '儲存' : '建立'}</button>{' '}
            <button type="button" onClick={cancelEdit}>取消</button>
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
          title="發現同名學生"
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
