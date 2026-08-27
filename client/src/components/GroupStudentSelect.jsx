import SearchSelect from './SearchSelect';
import { defaultPriceForGrade } from '../lib/pricing';

const CHINESE_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// 中文數字（1-99 已足夠涵蓋一對多班級的合理人數上限），超出範圍就退回阿拉伯數字
function toChineseNumber(n) {
  if (n < 1 || n > 99) return String(n);
  if (n < 10) return CHINESE_DIGITS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${tens > 1 ? CHINESE_DIGITS[tens] : ''}十${ones ? CHINESE_DIGITS[ones] : ''}`;
}

// 一對多排課用：選擇「一對幾」再逐一挑學生＋單堂價錢，上限由「設定」子系統的 group_class_max_students 決定
// onFieldComplete 是選用的：填完某個欄位時回報欄位 key（如 `student-0`、`price-0`），
// 讓外層表單（例如排課彈窗）可以接手把焦點移到下一個欄位，不影響沒有用到這個 prop 的其他呼叫端
export default function GroupStudentSelect({ students, school, maxGroupSize, entries, onChange, onFieldComplete }) {
  const groupSize = entries.length || 1;

  const setGroupSize = (size) => {
    const next = Array.from({ length: size }, (_, i) => entries[i] || { student_id: '', unit_price: 0 });
    onChange(next);
    onFieldComplete?.('group-size');
  };

  const setEntry = (idx, patch) => {
    const next = entries.map((e, i) => (i === idx ? { ...e, ...patch } : e));
    onChange(next);
  };

  // 換學生時一律重新帶入該學生的年級預設單堂價錢，避免沿用前一位學生留下的金額
  const pickStudent = (idx, studentId) => {
    const student = students.find((s) => s.id === studentId);
    setEntry(idx, { student_id: studentId, unit_price: student ? defaultPriceForGrade(school, student.grade) : 0 });
    onFieldComplete?.(`student-${idx}`);
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <label data-field="group-size">
        班級人數
        <select value={groupSize} onChange={(e) => setGroupSize(Number(e.target.value))}>
          {Array.from({ length: maxGroupSize }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>一對{toChineseNumber(n)}</option>
          ))}
        </select>
      </label>
      {entries.map((entry, idx) => {
        const chosenElsewhere = entries.filter((_, i) => i !== idx).map((e) => e.student_id);
        const options = students.filter((s) => !chosenElsewhere.includes(s.id));
        return (
          <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <label style={{ flex: 1 }} data-field={`student-${idx}`}>
              {entries.length > 1 ? `學生 ${idx + 1}` : '學生'}
              <SearchSelect
                options={options}
                value={entry.student_id}
                onChange={(id) => pickStudent(idx, id)}
                placeholder="姓名搜尋..."
              />
            </label>
            <label data-field={`price-${idx}`}>
              單堂價錢
              <input
                type="number"
                value={entry.unit_price}
                onChange={(e) => setEntry(idx, { unit_price: Number(e.target.value) || 0 })}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  onFieldComplete?.(`price-${idx}`);
                }}
                style={{ width: 90 }}
              />
            </label>
          </div>
        );
      })}
    </div>
  );
}
