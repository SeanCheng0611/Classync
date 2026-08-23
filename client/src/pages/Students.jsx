import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';

const GRADES = Array.from({ length: 12 }, (_, i) => i + 1);

const emptyForm = { student_no: '', name: '', grade: 1, school_name: '', status: 'active', note: '' };

export default function Students() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = ['admin', 'front_desk'].includes(currentMembership?.role);
  const isStrictAdmin = currentMembership?.role === 'admin';

  const [students, setStudents] = useState([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);
  const formRef = useRef(null);

  const [showPriceSettings, setShowPriceSettings] = useState(false);
  const [priceForm, setPriceForm] = useState({ default_price_grade_1_6: 0, default_price_grade_7_9: 0, default_price_grade_10_12: 0 });

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    const [studentRows, school] = await Promise.all([
      api.get(`/api/schools/${currentSchoolId}/students`),
      api.get(`/api/schools/${currentSchoolId}`),
    ]);
    setStudents(studentRows);
    setPriceForm({
      default_price_grade_1_6: school.default_price_grade_1_6,
      default_price_grade_7_9: school.default_price_grade_7_9,
      default_price_grade_10_12: school.default_price_grade_10_12,
    });
  }, [currentSchoolId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'students' || resource === 'tuition-defaults') load();
    });
  }, [currentSchoolId, load]);

  const savePriceSettings = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/tuition-defaults`, {
        default_price_grade_1_6: Number(priceForm.default_price_grade_1_6) || 0,
        default_price_grade_7_9: Number(priceForm.default_price_grade_7_9) || 0,
        default_price_grade_10_12: Number(priceForm.default_price_grade_10_12) || 0,
      });
      setShowPriceSettings(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const startEdit = (student) => {
    setError('');
    if (student) {
      setForm({
        student_no: student.student_no || '',
        name: student.name,
        grade: student.grade,
        school_name: student.school_name || '',
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
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    const payload = {
      student_no: form.student_no.trim() || null,
      name: form.name.trim(),
      grade: Number(form.grade),
      school_name: form.school_name.trim() || null,
      status: form.status,
      note: form.note.trim() || null,
    };
    try {
      const result = editing?.id
        ? await api.put(`/api/schools/${currentSchoolId}/students/${editing.id}`, payload)
        : await api.post(`/api/schools/${currentSchoolId}/students`, payload);
      cancelEdit();
      load();
      if (result.duplicate_name) {
        alert(`已有同名學生「${result.name}」，請確認是否為重複。`);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (student) => {
    if (!confirm(`確定要刪除學生「${student.name}」嗎？`)) return;
    await api.del(`/api/schools/${currentSchoolId}/students/${student.id}`);
    load();
  };

  // 匯入 Excel：第一列為標題（A1 必須為「學生」，用於辨識檔案類型；編號/姓名/年級/學校），從第二列開始逐列讀取姓名(B)/年級(C)/學校(D)
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
      if (marker !== '學生') {
        setError('匯入失敗：檔案類型錯誤，請確認上傳的是學生名單。');
        setImporting(false);
        return;
      }

      let created = 0;
      let skipped = 0;
      const duplicateNoRows = [];
      const duplicateNameRows = [];
      const invalidRows = [];
      for (const [idx, row] of rows.slice(1).entries()) {
        const studentNo = row?.[0] != null ? String(row[0]).trim() : '';
        const name = row?.[1] != null ? String(row[1]).trim() : '';
        const grade = Number(row?.[2]);
        const schoolName = row?.[3] != null ? String(row[3]).trim() : '';
        if (!studentNo) continue; // 沒填編號視為空白列，不計入略過
        if (!name || !grade) {
          skipped++;
          invalidRows.push(name ? `第 ${idx + 2} 列「${name}」（年級格式錯誤）` : `第 ${idx + 2} 列（編號 ${studentNo}，缺姓名）`);
          continue;
        }
        try {
          const result = await api.post(`/api/schools/${currentSchoolId}/students`, {
            student_no: studentNo || null,
            name,
            grade,
            school_name: schoolName || null,
          });
          created++;
          if (result.duplicate_name) duplicateNameRows.push(name);
        } catch (err) {
          skipped++;
          duplicateNoRows.push(`${name}（編號 ${studentNo}）：${err.message}`);
        }
      }
      load();
      let summary = `匯入完成：新增 ${created} 位，略過 ${skipped} 位`;
      if (invalidRows.length > 0) {
        summary += `\n\n以下列缺姓名或年級格式錯誤，未匯入：\n${invalidRows.join('\n')}`;
      }
      if (duplicateNoRows.length > 0) {
        summary += `\n\n以下列因編號重複等原因未匯入：\n${duplicateNoRows.join('\n')}`;
      }
      if (duplicateNameRows.length > 0) {
        summary += `\n\n以下姓名與既有學生重複，已照常新增，請確認是否重複：\n${duplicateNameRows.join('、')}`;
      }
      alert(summary);
    } catch (err) {
      setError('讀取 Excel 檔案失敗：' + err.message);
    } finally {
      setImporting(false);
    }
  };

  const filteredStudents = students.filter((s) => s.name.includes(search.trim()));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>學生檔案</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {isStrictAdmin && (
            <button onClick={() => setShowPriceSettings((v) => !v)}>
              {showPriceSettings ? '取消' : '單堂預設金額設定'}
            </button>
          )}
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
              <button onClick={() => startEdit(null)}>+ 新增學生</button>
            </>
          )}
        </div>
      </div>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {showPriceSettings && (
        <form
          onSubmit={savePriceSettings}
          style={{ marginTop: 12, marginBottom: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 6, display: 'grid', gap: 8, maxWidth: 320 }}
        >
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
            新增固定課程或單堂加課時，將依學生年級自動帶入以下預設單堂金額（仍可手動更改）。
          </p>
          <label>
            1~6 年級
            <input
              type="number"
              value={priceForm.default_price_grade_1_6}
              onChange={(e) => setPriceForm({ ...priceForm, default_price_grade_1_6: e.target.value })}
            />
          </label>
          <label>
            7~9 年級
            <input
              type="number"
              value={priceForm.default_price_grade_7_9}
              onChange={(e) => setPriceForm({ ...priceForm, default_price_grade_7_9: e.target.value })}
            />
          </label>
          <label>
            10~12 年級
            <input
              type="number"
              value={priceForm.default_price_grade_10_12}
              onChange={(e) => setPriceForm({ ...priceForm, default_price_grade_10_12: e.target.value })}
            />
          </label>
          <div><button type="submit">儲存</button></div>
        </form>
      )}

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
            <th>年級</th>
            <th>學校</th>
            <th>狀態</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filteredStudents.map((s) => (
            <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td>{s.student_no}</td>
              <td><Link to={`/students/${s.id}`}>{s.name}</Link></td>
              <td>{s.grade}</td>
              <td>{s.school_name}</td>
              <td>{s.status === 'active' ? '在學' : '停用'}</td>
              <td>
                {isAdmin && (
                  <>
                    <button onClick={() => startEdit(s)}>編輯</button>{' '}
                    <button onClick={() => remove(s)}>刪除</button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {filteredStudents.length === 0 && (
            <tr>
              <td colSpan={6} style={{ color: 'var(--text-muted)', padding: 12 }}>
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
            編號
            <input value={form.student_no} onChange={(e) => setForm({ ...form, student_no: e.target.value })} />
          </label>
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
    </div>
  );
}
