// 各子系統「匯出 Excel」共用邏輯：預設字體標楷體、大小 12，存檔優先用 showSaveFilePicker 讓使用者選位置，
// 不支援的瀏覽器（或使用者取消）就退回下載資料夾
export const EXPORT_FONT = { name: '標楷體', size: 12 };
export const EXPORT_BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };

export async function saveWorkbookAs(workbook, filename) {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'Excel 檔案', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

// 幫整張表套上預設字體/框線（含標題列），呼叫端只要先把資料塞進 sheet.columns/addRow 就好
export function applyExportStyle(sheet) {
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.font = EXPORT_FONT;
      cell.border = EXPORT_BORDER;
    });
  });
}
