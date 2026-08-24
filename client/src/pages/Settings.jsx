import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import TimeInput from '../components/TimeInput';
import { DEFAULT_SUBJECTS, parseSubjects } from '../lib/subjects';
import { SWATCHES, TAG_TYPES, DEFAULT_TYPE_COLORS, parseTypeColors } from '../lib/sessionType';

function SettingsSection({ title, open, onToggle, onSubmit, children }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 12 }}>
      <button type="button" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {title} {open ? '▲' : '▼'}
      </button>
      {open && (
        <form onSubmit={onSubmit} style={{ display: 'grid', gap: 8, maxWidth: 320, marginTop: 8 }}>
          {children}
          <div><button type="submit">儲存</button></div>
        </form>
      )}
    </div>
  );
}

export default function Settings() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [school, setSchool] = useState(null);
  const [error, setError] = useState('');

  const [openTuition, setOpenTuition] = useState(false);
  const [tuitionForm, setTuitionForm] = useState({ default_price_grade_1_6: 0, default_price_grade_7_9: 0, default_price_grade_10_12: 0 });

  const [openGroup, setOpenGroup] = useState(false);
  const [groupForm, setGroupForm] = useState({ group_class_max_students: 2 });

  const [openTimeRange, setOpenTimeRange] = useState(false);
  const [timeRangeForm, setTimeRangeForm] = useState({ time_picker_range_start: '18:00', time_picker_range_end: '21:00', default_class_duration_hours: 1.5 });

  const [openSpan, setOpenSpan] = useState(false);
  const [spanForm, setSpanForm] = useState({ default_schedule_span_months: 4 });

  const [openSubjects, setOpenSubjects] = useState(false);
  const [newSubject, setNewSubject] = useState('');

  const [openTypeColors, setOpenTypeColors] = useState(false);
  const [typeColorsForm, setTypeColorsForm] = useState(DEFAULT_TYPE_COLORS);

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    try {
      const sch = await api.get(`/api/schools/${currentSchoolId}`);
      setSchool(sch);
      setTuitionForm({
        default_price_grade_1_6: sch.default_price_grade_1_6,
        default_price_grade_7_9: sch.default_price_grade_7_9,
        default_price_grade_10_12: sch.default_price_grade_10_12,
      });
      setGroupForm({ group_class_max_students: sch.group_class_max_students });
      setTimeRangeForm({
        time_picker_range_start: sch.time_picker_range_start,
        time_picker_range_end: sch.time_picker_range_end,
        default_class_duration_hours: sch.default_class_duration_hours,
      });
      setSpanForm({ default_schedule_span_months: sch.default_schedule_span_months });
      setTypeColorsForm(parseTypeColors(sch));
    } catch (err) {
      setError(err.message);
    }
  }, [currentSchoolId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!currentSchoolId) return;
    return subscribeSchool(currentSchoolId, (resource) => {
      if (resource === 'scheduling-settings' || resource === 'tuition-defaults') load();
    });
  }, [currentSchoolId, load]);

  if (!isAdmin) return <p>僅管理者可使用設定</p>;
  if (!school) return <p>載入中...</p>;

  const subjects = parseSubjects(school);

  const saveSubjects = async (next) => {
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/subjects`, { subjects: next });
    } catch (err) {
      setError(err.message);
    }
  };

  const addSubject = () => {
    const v = newSubject.trim();
    if (!v || subjects.includes(v)) return;
    saveSubjects([...subjects, v]);
    setNewSubject('');
  };

  const removeSubject = (s) => saveSubjects(subjects.filter((x) => x !== s));

  const resetSubjects = () => {
    if (!confirm('確定要恢復預設科目清單嗎？目前的自訂科目會被取代。')) return;
    saveSubjects(DEFAULT_SUBJECTS);
  };

  const saveTuition = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/tuition-defaults`, {
        default_price_grade_1_6: Number(tuitionForm.default_price_grade_1_6) || 0,
        default_price_grade_7_9: Number(tuitionForm.default_price_grade_7_9) || 0,
        default_price_grade_10_12: Number(tuitionForm.default_price_grade_10_12) || 0,
      });
      setOpenTuition(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const saveGroup = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/scheduling-settings`, {
        group_class_max_students: Number(groupForm.group_class_max_students),
      });
      setOpenGroup(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const saveTimeRange = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/scheduling-settings`, {
        time_picker_range_start: timeRangeForm.time_picker_range_start,
        time_picker_range_end: timeRangeForm.time_picker_range_end,
        default_class_duration_hours: Number(timeRangeForm.default_class_duration_hours) || 1.5,
      });
      setOpenTimeRange(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const saveSpan = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/scheduling-settings`, {
        default_schedule_span_months: Number(spanForm.default_schedule_span_months),
      });
      setOpenSpan(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const saveTypeColors = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/type-colors`, { type_colors: typeColorsForm });
      setOpenTypeColors(false);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <h2>設定</h2>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <h3 style={{ marginBottom: 4, color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, letterSpacing: 1 }}>排課設定</h3>

      <SettingsSection title="上課時段設定" open={openTimeRange} onToggle={() => setOpenTimeRange((v) => !v)} onSubmit={saveTimeRange}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label>
            起始
            <TimeInput
              value={timeRangeForm.time_picker_range_start}
              onChange={(v) => setTimeRangeForm({ ...timeRangeForm, time_picker_range_start: v })}
            />
          </label>
          <span style={{ marginTop: 18 }}>~</span>
          <label>
            結束
            <TimeInput
              value={timeRangeForm.time_picker_range_end}
              onChange={(v) => setTimeRangeForm({ ...timeRangeForm, time_picker_range_end: v })}
            />
          </label>
        </div>
        <label>
          預設堂課時長（小時）
          <input
            type="number"
            min="0.5"
            step="0.5"
            value={timeRangeForm.default_class_duration_hours}
            onChange={(e) => setTimeRangeForm({ ...timeRangeForm, default_class_duration_hours: e.target.value })}
          />
        </label>
      </SettingsSection>

      <SettingsSection title="團體班人數上限" open={openGroup} onToggle={() => setOpenGroup((v) => !v)} onSubmit={saveGroup}>
        <label>
          單一時段最多學生數（一對 N）
          <input
            type="number"
            min="1"
            value={groupForm.group_class_max_students}
            onChange={(e) => setGroupForm({ group_class_max_students: e.target.value })}
          />
        </label>
      </SettingsSection>

      <SettingsSection title="固定課展延月數" open={openSpan} onToggle={() => setOpenSpan((v) => !v)} onSubmit={saveSpan}>
        <label>
          結束月份留空時，預設展開幾個月
          <input
            type="number"
            min="1"
            value={spanForm.default_schedule_span_months}
            onChange={(e) => setSpanForm({ default_schedule_span_months: e.target.value })}
          />
        </label>
      </SettingsSection>

      <SettingsSection title="課表標註顏色" open={openTypeColors} onToggle={() => setOpenTypeColors((v) => !v)} onSubmit={saveTypeColors}>
        {TAG_TYPES.map(({ key, label }) => (
          <div key={key}>
            <div style={{ marginBottom: 4 }}>{label}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {Object.entries(SWATCHES).map(([swatchKey, swatch]) => (
                <button
                  key={swatchKey}
                  type="button"
                  title={swatch.label}
                  onClick={() => setTypeColorsForm({ ...typeColorsForm, [key]: swatchKey })}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    padding: 0,
                    background: swatch.color,
                    borderWidth: typeColorsForm[key] === swatchKey ? 3 : 1,
                    borderColor: typeColorsForm[key] === swatchKey ? 'var(--text)' : 'var(--border-strong)',
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </SettingsSection>

      <h3 style={{ marginBottom: 4, color: 'var(--text-muted)', fontSize: 14, fontWeight: 600, letterSpacing: 1 }}>收費與科目</h3>

      <SettingsSection title="學費預設金額" open={openTuition} onToggle={() => setOpenTuition((v) => !v)} onSubmit={saveTuition}>
        <label>
          1~6 年級
          <input type="number" value={tuitionForm.default_price_grade_1_6} onChange={(e) => setTuitionForm({ ...tuitionForm, default_price_grade_1_6: e.target.value })} />
        </label>
        <label>
          7~9 年級
          <input type="number" value={tuitionForm.default_price_grade_7_9} onChange={(e) => setTuitionForm({ ...tuitionForm, default_price_grade_7_9: e.target.value })} />
        </label>
        <label>
          10~12 年級
          <input type="number" value={tuitionForm.default_price_grade_10_12} onChange={(e) => setTuitionForm({ ...tuitionForm, default_price_grade_10_12: e.target.value })} />
        </label>
      </SettingsSection>

      <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 12 }}>
        <button type="button" onClick={() => setOpenSubjects((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          科目選單設定 {openSubjects ? '▲' : '▼'}
        </button>
        {openSubjects && (
          <div style={{ display: 'grid', gap: 6, maxWidth: 320, marginTop: 8 }}>
            {subjects.map((s) => (
              <div key={s} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{s}</span>
                <button type="button" onClick={() => removeSubject(s)}>刪除</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                placeholder="新增科目"
                style={{ flex: 1 }}
              />
              <button type="button" onClick={addSubject}>新增</button>
            </div>
            <div><button type="button" onClick={resetSubjects}>恢復預設</button></div>
          </div>
        )}
      </div>
    </div>
  );
}
