import { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { subscribeSchool } from '../socket';
import TimeInput from '../components/TimeInput';
import { DEFAULT_SUBJECTS, parseSubjects } from '../lib/subjects';
import { SWATCHES, TAG_TYPES, DEFAULT_TYPE_COLORS, parseTypeColors, DEFAULT_TYPE_ORDER, parseTypeOrder, parseAttendanceTypeOrder } from '../lib/sessionType';

const TYPE_ORDER_LABELS = Object.fromEntries(TAG_TYPES.map(({ key, label }) => [key, label]));

// 每個設定區塊的標題，也是「設定」頁面本身區塊排序功能的依據（見 DEFAULT_SECTION_ORDER / parseSectionOrder）
const SECTION_TITLES = {
  timeRange: '上課時段設定',
  group: '團體班人數上限',
  span: '固定課展延月數',
  typeColors: '課表標註顏色',
  typeOrder: '課表排列順序',
  attendanceOrder: '點名排列順序',
  tuition: '學費預設金額',
  subjects: '科目選單設定',
};

// 設定區塊分類：只能在同一分類內拖曳調整順序，不會跨分類混在一起
const SECTION_CATEGORIES = [
  { title: '排課設定', keys: ['timeRange', 'group', 'span', 'typeColors', 'typeOrder', 'attendanceOrder'] },
  { title: '收費與科目', keys: ['tuition', 'subjects'] },
];

// 預設順序：同分類內依標題字數由少到多排列（字數相同的維持原本宣告順序），使用者可在頁面上拖曳調整、之後就記住自訂順序
const DEFAULT_SECTION_ORDER = SECTION_CATEGORIES.flatMap(({ keys }) =>
  keys.slice().sort((a, b) => SECTION_TITLES[a].length - SECTION_TITLES[b].length)
);

function parseSectionOrder(schoolSettings) {
  try {
    const parsed = JSON.parse(schoolSettings?.settings_section_order || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      // 過濾掉不存在的 key（例如舊資料殘留），把新增的區塊（尚未出現在使用者自訂順序裡）補到最後
      const filtered = parsed.filter((k) => SECTION_TITLES[k]);
      const missing = DEFAULT_SECTION_ORDER.filter((k) => !filtered.includes(k));
      return [...filtered, ...missing];
    }
  } catch {
    // 解析失敗就用預設順序
  }
  return DEFAULT_SECTION_ORDER;
}

// 通用的拖曳排序清單：固定課/加課/調課排列順序（課表／點名排列順序）共用同一套邏輯
function DragOrderEditor({ value, labels, onChange }) {
  const [dragIndex, setDragIndex] = useState(null);

  const reorder = (fromIndex, toIndex) => {
    if (fromIndex === toIndex || fromIndex == null || toIndex == null) return;
    const next = value.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onChange(next);
  };

  return (
    <>
      {value.map((key, i) => (
        <div
          key={key}
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            reorder(dragIndex, i);
            setDragIndex(null);
          }}
          onDragEnd={() => setDragIndex(null)}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '4px 8px',
            border: '1px solid var(--border-strong)',
            borderRadius: 4,
            cursor: 'grab',
            background: dragIndex === i ? 'var(--surface-muted)' : undefined,
          }}
        >
          <span>{i + 1}. {labels[key]}</span>
          <span style={{ color: 'var(--text-muted)' }}>⠿</span>
        </div>
      ))}
    </>
  );
}

// onSubmit 是選用的：有給就包一層 <form> 並顯示「儲存」按鈕，沒給（例如科目選單設定，動作即時生效不需要另外儲存）就單純顯示內容
function SettingsSection({ title, open, onToggle, onSubmit, children }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 12 }}>
      <button type="button" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {title} {open ? '▲' : '▼'}
      </button>
      {open && onSubmit && (
        <form onSubmit={onSubmit} style={{ display: 'grid', gap: 8, maxWidth: 320, marginTop: 8 }}>
          {children}
          <div><button type="submit">儲存</button></div>
        </form>
      )}
      {open && !onSubmit && <div style={{ display: 'grid', gap: 8, maxWidth: 320, marginTop: 8 }}>{children}</div>}
    </div>
  );
}

export default function Settings() {
  const { currentSchoolId, currentMembership } = useAuth();
  const isAdmin = currentMembership?.role === 'admin';

  const [school, setSchool] = useState(null);
  const [error, setError] = useState('');

  const [sectionOrder, setSectionOrder] = useState(DEFAULT_SECTION_ORDER);
  const [dragSection, setDragSection] = useState(null); // { category, index }：目前拖曳中的區塊屬於哪個分類、在該分類內第幾個

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

  const [openTypeOrder, setOpenTypeOrder] = useState(false);
  const [typeOrderForm, setTypeOrderForm] = useState(DEFAULT_TYPE_ORDER);

  const [openAttendanceOrder, setOpenAttendanceOrder] = useState(false);
  const [attendanceOrderForm, setAttendanceOrderForm] = useState(DEFAULT_TYPE_ORDER);

  const load = useCallback(async () => {
    if (!currentSchoolId) return;
    try {
      const sch = await api.get(`/api/schools/${currentSchoolId}`);
      setSchool(sch);
      setSectionOrder(parseSectionOrder(sch));
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
      setTypeOrderForm(parseTypeOrder(sch));
      setAttendanceOrderForm(parseAttendanceTypeOrder(sch));
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

  // 拖曳調整設定區塊本身的順序：只能在同一分類內調整，立刻套用畫面、同時存回後端，不需要另外按「儲存」
  const reorderSectionsWithinCategory = async (category, fromIndex, toIndex) => {
    if (fromIndex === toIndex || fromIndex == null || toIndex == null) return;
    const byCategory = SECTION_CATEGORIES.map(({ keys }) => sectionOrder.filter((k) => keys.includes(k)));
    const catIdx = SECTION_CATEGORIES.findIndex((c) => c.title === category);
    if (catIdx === -1) return;
    const list = byCategory[catIdx].slice();
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    byCategory[catIdx] = list;
    const next = byCategory.flat();
    setSectionOrder(next);
    try {
      await api.put(`/api/schools/${currentSchoolId}/settings-section-order`, { settings_section_order: next });
    } catch (err) {
      setError(err.message);
    }
  };

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

  const saveTypeOrder = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/schedule-type-order`, { schedule_type_order: typeOrderForm });
      setOpenTypeOrder(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const saveAttendanceOrder = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.put(`/api/schools/${currentSchoolId}/attendance-type-order`, { attendance_type_order: attendanceOrderForm });
      setOpenAttendanceOrder(false);
    } catch (err) {
      setError(err.message);
    }
  };

  // 每個設定區塊的實際內容，key 對應 SECTION_TITLES；畫面上依 sectionOrder（可拖曳自訂）決定顯示順序
  const sectionRenderers = {
    timeRange: (
      <SettingsSection title={SECTION_TITLES.timeRange} open={openTimeRange} onToggle={() => setOpenTimeRange((v) => !v)} onSubmit={saveTimeRange}>
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
    ),
    group: (
      <SettingsSection title={SECTION_TITLES.group} open={openGroup} onToggle={() => setOpenGroup((v) => !v)} onSubmit={saveGroup}>
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
    ),
    span: (
      <SettingsSection title={SECTION_TITLES.span} open={openSpan} onToggle={() => setOpenSpan((v) => !v)} onSubmit={saveSpan}>
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
    ),
    typeColors: (
      <SettingsSection title={SECTION_TITLES.typeColors} open={openTypeColors} onToggle={() => setOpenTypeColors((v) => !v)} onSubmit={saveTypeColors}>
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
    ),
    typeOrder: (
      <SettingsSection title={SECTION_TITLES.typeOrder} open={openTypeOrder} onToggle={() => setOpenTypeOrder((v) => !v)} onSubmit={saveTypeOrder}>
        <DragOrderEditor value={typeOrderForm} labels={TYPE_ORDER_LABELS} onChange={setTypeOrderForm} />
      </SettingsSection>
    ),
    attendanceOrder: (
      <SettingsSection title={SECTION_TITLES.attendanceOrder} open={openAttendanceOrder} onToggle={() => setOpenAttendanceOrder((v) => !v)} onSubmit={saveAttendanceOrder}>
        <DragOrderEditor value={attendanceOrderForm} labels={TYPE_ORDER_LABELS} onChange={setAttendanceOrderForm} />
      </SettingsSection>
    ),
    tuition: (
      <SettingsSection title={SECTION_TITLES.tuition} open={openTuition} onToggle={() => setOpenTuition((v) => !v)} onSubmit={saveTuition}>
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
    ),
    subjects: (
      <SettingsSection title={SECTION_TITLES.subjects} open={openSubjects} onToggle={() => setOpenSubjects((v) => !v)}>
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
      </SettingsSection>
    ),
  };

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <h2>設定</h2>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      {SECTION_CATEGORIES.map(({ title: category, keys }, catIdx) => {
        const items = sectionOrder.filter((k) => keys.includes(k));
        return (
          <div key={category}>
            <h3
              style={{
                marginTop: catIdx === 0 ? 0 : 16,
                marginBottom: 4,
                color: 'var(--text-muted)',
                fontSize: 14,
                fontWeight: 600,
                letterSpacing: 1,
              }}
            >
              {category}
            </h3>
            {items.map((key, i) => (
              <div key={key} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span
                  draggable
                  onDragStart={() => setDragSection({ category, index: i })}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragSection?.category === category) reorderSectionsWithinCategory(category, dragSection.index, i);
                    setDragSection(null);
                  }}
                  onDragEnd={() => setDragSection(null)}
                  title="拖曳調整這個設定區塊的順序（僅限同分類內）"
                  style={{ cursor: 'grab', color: 'var(--text-muted)', padding: '10px 2px 0 0', flexShrink: 0 }}
                >
                  ⠿
                </span>
                <div style={{ flex: 1 }}>{sectionRenderers[key]}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
