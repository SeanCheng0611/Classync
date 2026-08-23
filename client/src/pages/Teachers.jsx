import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';

const emptyForm = {
  teacher_no: '',
  name: '',
  subjects: '',
  rate_grade_1_6: 0,
  rate_grade_7_9: 0,
  rate_grade_10_12: 0,
  rate_admin: 0,
  note: '',
};

export default function Teachers() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);

  const [teachers, setTeachers] = useState([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);
  const formRef = useRef(null);

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

  const startEdit = (teacher) => {
    setError('');
    if (teacher) {
      setForm({
        teacher_no: teacher.teacher_no || '',
        name: teacher.name,
        subjects: teacher.subjects.join(', '),
        rate_grade_1_6: teacher.rate_grade_1_6,
        rate_grade_7_9: teacher.rate_grade_7_9,
        rate_grade_10_12: teacher.rate_grade_10_12,
        rate_admin: teacher.rate_admin,
        note: teacher.note || '',
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
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    const payload = {
      teacher_no: form.teacher_no.trim() || null,
      name: form.name.trim(),
      subjects: form.subjects
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      rate_grade_1_6: Number(form.rate_grade_1_6) || 0,
      rate_grade_7_9: Number(form.rate_grade_7_9) || 0,
      rate_grade_10_12: Number(form.rate_grade_10_12) || 0,
      rate_admin: Number(form.rate_admin) || 0,
      note: form.note.trim() || null,
    };
    try {
      let result;
      if (editing?.id) {
        result = await api.put(`/api/schools/${currentSchoolId}/teachers/${editing.id}`, payload);
      } else {
        result = await api.post(`/api/schools/${currentSchoolId}/teachers`, payload);
      }
      cancelEdit();
      load();
      if (result.duplicate_name) {
        alert(`已有同名教師「${result.name}」，請確認是否為重複。`);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (teacher) => {
    if (!confirm(`確定要刪除教師「${teacher.name}」嗎？`)) return;
    await api.del(`/api/schools/${currentSchoolId}/teachers/${teacher.id}`);
    load();
  };

  // 匯入 Excel：第一列為標題（A1 必須為「教師」，用於辨識檔案類型；編號/姓名/科目/時薪-1~6年級/時薪-7~9年級/時薪-10~12年級/時薪-行政/備註），從第二列開始讀取
  // 時薪欄位空白視為 0，備註欄位空白就維持空白（不強制填 0）；編號不可重複，姓名重複則照常新增並提醒
  const importExcel = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError('');
    setImporting(true);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      const marker = rows[0]?.[0] != null ? String(rows[0][0]).trim() : '';
      if (marker !== '教師') {
        setError('匯入失敗：檔案類型錯誤，請確認上傳的是教師名單。');
        setImporting(false);
        return;
      }

      let created = 0;
      let skipped = 0;
      const failedRows = [];
      const duplicateNameRows = [];
      const invalidRows = [];
      for (const [idx, row] of rows.slice(1).entries()) {
        const teacherNo = row?.[0] != null ? String(row[0]).trim() : '';
        const name = row?.[1] != null ? String(row[1]).trim() : '';
        const subjectsText = row?.[2] != null ? String(row[2]).trim() : '';
        const rate16 = row?.[3] != null && String(row[3]).trim() !== '' ? Number(row[3]) : 0;
        const rate79 = row?.[4] != null && String(row[4]).trim() !== '' ? Number(row[4]) : 0;
        const rate1012 = row?.[5] != null && String(row[5]).trim() !== '' ? Number(row[5]) : 0;
        const rateAdmin = row?.[6] != null && String(row[6]).trim() !== '' ? Number(row[6]) : 0;
        const note = row?.[7] != null ? String(row[7]).trim() : '';
        if (!teacherNo) continue; // 沒填編號視為空白列，不計入略過
        if (!name) {
          skipped++;
          invalidRows.push(`第 ${idx + 2} 列（編號 ${teacherNo}，缺姓名）`);
          continue;
        }
        try {
          const result = await api.post(`/api/schools/${currentSchoolId}/teachers`, {
            teacher_no: teacherNo || null,
            name,
            subjects: subjectsText.split(/\s+/).filter(Boolean),
            rate_grade_1_6: rate16,
            rate_grade_7_9: rate79,
            rate_grade_10_12: rate1012,
            rate_admin: rateAdmin,
            note: note || null,
          });
          created++;
          if (result.duplicate_name) duplicateNameRows.push(name);
        } catch (err) {
          skipped++;
          failedRows.push(`${name}（編號 ${teacherNo}）：${err.message}`);
        }
      }
      load();
      let summary = `匯入完成：新增 ${created} 位，略過 ${skipped} 位`;
      if (invalidRows.length > 0) summary += `\n\n以下列缺姓名，未匯入：\n${invalidRows.join('\n')}`;
      if (failedRows.length > 0) summary += `\n\n未匯入的列：\n${failedRows.join('\n')}`;
      if (duplicateNameRows.length > 0) {
        summary += `\n\n以下姓名與既有教師重複，已照常新增，請確認是否重複：\n${duplicateNameRows.join('、')}`;
      }
      alert(summary);
    } catch (err) {
      setError('讀取 Excel 檔案失敗：' + err.message);
    } finally {
      setImporting(false);
    }
  };

  const filteredTeachers = teachers.filter((t) => t.name.includes(search.trim()));

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
              <button onClick={() => startEdit(null)}>+ 新增教師</button>
            </>
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

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border-strong)' }}>
            <th>編號</th>
            <th>姓名</th>
            <th>科目</th>
            <th>時薪(1-6)</th>
            <th>時薪(7-9)</th>
            <th>時薪(10-12)</th>
            <th>時薪(行政)</th>
            <th>備註</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filteredTeachers.map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td>{t.teacher_no}</td>
              <td><Link to={`/teachers/${t.id}`}>{t.name}</Link></td>
              <td>{t.subjects.join(', ')}</td>
              <td>{t.rate_grade_1_6}</td>
              <td>{t.rate_grade_7_9}</td>
              <td>{t.rate_grade_10_12}</td>
              <td>{t.rate_admin}</td>
              <td>{t.note}</td>
              <td>
                {isAdmin && (
                  <>
                    <button onClick={() => startEdit(t)}>編輯</button>{' '}
                    <button onClick={() => remove(t)}>刪除</button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {filteredTeachers.length === 0 && (
            <tr>
              <td colSpan={9} style={{ color: 'var(--text-muted)', padding: 12 }}>
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
            編號
            <input value={form.teacher_no} onChange={(e) => setForm({ ...form, teacher_no: e.target.value })} />
          </label>
          <label>
            姓名
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            科目
            <input value={form.subjects} onChange={(e) => setForm({ ...form, subjects: e.target.value })} />
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
          <label>
            備註
            <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </label>
          <div>
            <button type="submit">儲存</button> <button type="button" onClick={cancelEdit}>取消</button>
          </div>
        </form>
      )}
    </div>
  );
}
