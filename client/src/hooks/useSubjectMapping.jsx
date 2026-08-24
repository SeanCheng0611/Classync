import { useRef, useState } from 'react';
import { api } from '../api';
import SubjectMappingModal from '../components/SubjectMappingModal';

// Excel 匯入科目比對／新增：把匯入的原始科目文字跟目前選單比對，選單沒有的就跳窗詢問要對應到哪一項或新增
export function useSubjectMapping(currentSchoolId) {
  const [modalState, setModalState] = useState(null);
  const resolverRef = useRef(null);

  const askSubjectMapping = (rawText, options) =>
    new Promise((resolve) => {
      resolverRef.current = resolve;
      setModalState({ rawText, options });
    });

  const resolve = (code) => {
    setModalState(null);
    resolverRef.current?.(code);
    resolverRef.current = null;
  };

  // 建立單次匯入批次用的解析函式：known 隨批次內新增的科目持續累積，同一段原始文字只問一次
  const createResolver = (initialSubjects) => {
    const known = new Set(initialSubjects);
    const cache = new Map();
    return async function resolveSubjectToken(raw) {
      const text = String(raw).trim();
      if (!text) return null;
      if (known.has(text)) return text;
      if (cache.has(text)) return cache.get(text);
      const code = await askSubjectMapping(text, [...known]);
      cache.set(text, code);
      if (code) known.add(code);
      return code;
    };
  };

  const modal = modalState && (
    <SubjectMappingModal
      rawText={modalState.rawText}
      options={modalState.options}
      onSelect={(code) => resolve(code)}
      onAddNew={async (code) => {
        const merged = [...modalState.options, code].filter((v, i, arr) => arr.indexOf(v) === i);
        try {
          await api.put(`/api/schools/${currentSchoolId}/subjects`, { subjects: merged });
        } catch {
          // 選單更新失敗也不擋匯入，這筆先用新代碼繼續，使用者可事後在設定頁補上
        }
        resolve(code);
      }}
      onSkip={() => resolve(null)}
    />
  );

  return { createResolver, modal };
}
