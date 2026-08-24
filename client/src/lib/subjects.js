export const DEFAULT_SUBJECTS = ['C', 'E', 'M', 'N', 'S', 'PHY', 'CHEM', 'HIST', 'GEO', 'CIV', 'AD', 'J'];

export function parseSubjects(schoolSettings) {
  try {
    const parsed = schoolSettings?.subjects ? JSON.parse(schoolSettings.subjects) : null;
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_SUBJECTS;
  } catch {
    return DEFAULT_SUBJECTS;
  }
}
