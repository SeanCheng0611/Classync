// 依學生年級，從補習班的年級級距預設金額中取得對應單堂價錢
export function defaultPriceForGrade(school, grade) {
  if (!school) return 0;
  const g = Number(grade);
  if (g <= 6) return school.default_price_grade_1_6 ?? 0;
  if (g <= 9) return school.default_price_grade_7_9 ?? 0;
  return school.default_price_grade_10_12 ?? 0;
}
