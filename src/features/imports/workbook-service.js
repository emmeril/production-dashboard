function createImportWorkbookService(dependencies) {
  const {
    ExcelJS,
    PRODUCTION_HOURS,
    QC_IMPORT_HOURS,
    buildDateReportRows,
    getAvailableHistoryDates,
    getToday,
    readDefectConfig,
    readProductionSnapshotForDate
  } = dependencies;

  function getProductionImportTemplateSampleRows(limit = 6) {
    const today = getToday();
    const candidates = getAvailableHistoryDates()
      .filter(date => date < today)
      .flatMap(date => {
        const snapshot = readProductionSnapshotForDate(date);
        if (!snapshot) return [];
        return buildDateReportRows(snapshot, date).map(row => ({
          ...row,
          hourlyData: snapshot.lines?.[row.line]?.models?.[row.modelId]?.hourly_data || [],
          qcChecks: snapshot.lines?.[row.line]?.models?.[row.modelId]?.qcChecks || []
        }));
      })
      .filter(row => row.date && row.line && row.model);

    return candidates
      .sort((a, b) => {
        const defectPriority = Number((b.defect || 0) > 0) - Number((a.defect || 0) > 0);
        return defectPriority
          || String(b.date).localeCompare(String(a.date))
          || (Number(b.defect) || 0) - (Number(a.defect) || 0)
          || String(a.line).localeCompare(String(b.line));
      })
      .slice(0, limit);
  }

  function styleImportWorksheet(sheet, widths, endColumn) {
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };
    sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    sheet.getRow(1).height = 30;
    widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    sheet.autoFilter = { from: `A1`, to: `${endColumn}1` };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
  }

  function sewingImportTemplateWorkbook(options = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Production Dashboard System';
    const samples = Array.isArray(options.sampleRows) ? options.sampleRows : getProductionImportTemplateSampleRows(3);
    const headers = ['Tanggal', 'Line', 'Label/Week', 'Model', 'Jam', 'Target Manual', 'Output', 'Catatan'];
    const widths = [14, 18, 18, 38, 20, 16, 14, 32];
    const sheet = workbook.addWorksheet('Data Produksi');
    sheet.addRow(headers);
    styleImportWorksheet(sheet, widths, 'H');
    sheet.getColumn(1).numFmt = 'yyyy-mm-dd';
    [6, 7].forEach(column => { sheet.getColumn(column).numFmt = '0'; });

    const reference = workbook.addWorksheet('Referensi Jam');
    reference.addRow(['Jam Produksi']);
    PRODUCTION_HOURS.forEach(hour => reference.addRow([hour]));
    reference.getColumn(1).width = 22;
    reference.getRow(1).font = { bold: true };
    for (let row = 2; row <= 2001; row += 1) {
      sheet.getCell(row, 5).dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: [`'Referensi Jam'!$A$2:$A$${PRODUCTION_HOURS.length + 1}`]
      };
    }

    const instructions = workbook.addWorksheet('Petunjuk');
    instructions.addRow(['Bagian', 'Keterangan']);
    [
      ['Tujuan', 'Input khusus data hasil produksi. Tidak mengubah data QC yang sudah tersimpan.'],
      ['Satu baris', 'Satu jam produksi untuk satu model. Pilih Jam dari dropdown.'],
      ['Jam wajib', `Isi seluruh ${PRODUCTION_HOURS.length} jam produksi untuk setiap model: ${PRODUCTION_HOURS.join(', ')}.`],
      ['Target Manual dan Output', 'Wajib berupa bilangan bulat tidak negatif. Total harian dihitung otomatis dari seluruh baris per jam.'],
      ['Identitas model', 'Tanggal, Line, Label/Week, dan Model harus sama pada seluruh jam untuk model yang sama.'],
      ['Urutan input', 'Input Produksi terlebih dahulu. Setelah berhasil, gunakan template Input QC.']
    ].forEach(row => instructions.addRow(row));
    instructions.getColumn(1).width = 26;
    instructions.getColumn(2).width = 105;
    instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };
    instructions.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; row.height = 34; });

    const example = workbook.addWorksheet('Contoh Riil');
    example.addRow(headers);
    styleImportWorksheet(example, widths, 'H');
    samples.forEach(sample => {
      (sample.hourlyData || []).filter(hour => PRODUCTION_HOURS.includes(hour.hour)).forEach(hour => {
        example.addRow([
          sample.date, sample.line, sample.labelWeek || '', sample.model || '', hour.hour,
          parseInt(hour.targetManual) || 0, parseInt(hour.output) || 0, 'Contoh dari data tersimpan'
        ]);
      });
    });
    if (example.rowCount === 1) example.addRow(['Belum ada contoh data produksi historis.']);
    return workbook;
  }

  function buildQcImportSampleEntries(samples = []) {
    const rows = [];
    samples.forEach(sample => {
      const defectsByHour = new Map();
      (sample.qcChecks || []).filter(check => check.result === 'defect').forEach(check => {
        const hour = check.hour || sample.hourlyData?.[parseInt(check.hourIndex)]?.hour || '';
        if (!QC_IMPORT_HOURS.includes(hour)) return;
        const key = `${hour}|${check.type}|${check.area}`;
        const current = defectsByHour.get(key) || { hour, type: check.type, area: check.area, quantity: 0, notes: check.notes || '' };
        current.quantity += Math.max(parseInt(check.quantity) || 1, 1);
        defectsByHour.set(key, current);
      });
      (sample.hourlyData || []).filter(hour => QC_IMPORT_HOURS.includes(hour.hour)).forEach(hour => {
        const good = Math.max((parseInt(hour.qcChecked) || 0) - (parseInt(hour.defect) || 0), 0);
        if (good > 0) rows.push({ sample, hour: hour.hour, result: 'Good', quantity: good, type: '', area: '', notes: '' });
        const details = Array.from(defectsByHour.values()).filter(detail => detail.hour === hour.hour);
        if (details.length > 0) {
          details.forEach(detail => rows.push({ sample, hour: hour.hour, result: 'Defect', ...detail }));
        } else {
          (hour.defectDetails || []).forEach(detail => rows.push({
            sample,
            hour: hour.hour,
            result: 'Defect',
            quantity: parseInt(detail.quantity) || 1,
            type: detail.type || '',
            area: detail.area || '',
            notes: detail.notes || ''
          }));
        }
      });
    });
    return rows;
  }

  function qcImportTemplateWorkbook(options = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Production Dashboard System';
    const defectConfig = options.defectConfig || readDefectConfig();
    const samples = Array.isArray(options.sampleRows) ? options.sampleRows : getProductionImportTemplateSampleRows(3);
    const headers = ['Tanggal', 'Line', 'Label/Week', 'Model', 'Jam', 'Hasil QC', 'Qty', 'Jenis Defect', 'Defect Area', 'Catatan'];
    const widths = [14, 18, 18, 38, 20, 14, 12, 34, 34, 34];
    const sheet = workbook.addWorksheet('Data QC');
    sheet.addRow(headers);
    styleImportWorksheet(sheet, widths, 'J');
    sheet.getColumn(1).numFmt = 'yyyy-mm-dd';
    sheet.getColumn(7).numFmt = '0';

    const reference = workbook.addWorksheet('Referensi Defect');
    reference.addRow(['Jenis Defect', 'Severity', '', 'Defect Area', '', 'Jam Produksi']);
    const types = defectConfig.defectTypes || [];
    const areas = defectConfig.defectAreas || [];
    const maxRows = Math.max(types.length, areas.length, QC_IMPORT_HOURS.length);
    for (let index = 0; index < maxRows; index += 1) {
      reference.addRow([
        types[index]?.name || '', types[index]?.severity || '', '', areas[index]?.name || '', '', QC_IMPORT_HOURS[index] || ''
      ]);
    }
    [34, 14, 4, 34, 4, 22].forEach((width, index) => { reference.getColumn(index + 1).width = width; });
    reference.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    reference.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };

    const typeEnd = Math.max(types.length + 1, 2);
    const areaEnd = Math.max(areas.length + 1, 2);
    for (let row = 2; row <= 2001; row += 1) {
      sheet.getCell(row, 5).dataValidation = { type: 'list', allowBlank: false, formulae: [`'Referensi Defect'!$F$2:$F$${QC_IMPORT_HOURS.length + 1}`] };
      sheet.getCell(row, 6).dataValidation = { type: 'list', allowBlank: false, formulae: ['"Good,Defect"'] };
      sheet.getCell(row, 7).dataValidation = { type: 'whole', operator: 'greaterThanOrEqual', allowBlank: false, formulae: [1] };
      sheet.getCell(row, 8).dataValidation = { type: 'list', allowBlank: true, formulae: [`'Referensi Defect'!$A$2:$A$${typeEnd}`] };
      sheet.getCell(row, 9).dataValidation = { type: 'list', allowBlank: true, formulae: [`'Referensi Defect'!$D$2:$D$${areaEnd}`] };
    }

    const instructions = workbook.addWorksheet('Petunjuk');
    instructions.addRow(['Bagian', 'Keterangan']);
    [
      ['Tujuan', 'Import khusus hasil QC. Data target dan output sewing tidak diubah.'],
      ['Satu baris', 'Satu hasil QC untuk satu jam. Gunakan Qty untuk jumlah hasil dengan kategori yang sama.'],
      ['Hasil Good', 'Pilih Good, isi Qty, lalu kosongkan Jenis Defect dan Defect Area.'],
      ['Hasil Defect', 'Pilih Defect, isi Qty, lalu pilih Jenis Defect dan Defect Area dari dropdown.'],
      ['Jam istirahat', 'Pilihan 11:00 - 13:00 tersedia untuk data QC historis yang memang dicatat pada jam istirahat.'],
      ['Perhitungan', 'QC Checked, Total Defect, severity, Good, dan defect rate dihitung otomatis oleh sistem.'],
      ['Pencocokan', 'Tanggal, Line, Label/Week, dan Model harus sama dengan data Sewing yang sudah diimport.'],
      ['Defect Area tersedia', areas.map(area => area.name).join(', ') || 'Belum ada area defect.'],
      ['Jenis Defect tersedia', types.map(type => `${type.name} (${type.severity})`).join(', ') || 'Belum ada jenis defect.']
    ].forEach(row => instructions.addRow(row));
    instructions.getColumn(1).width = 26;
    instructions.getColumn(2).width = 105;
    instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };
    instructions.eachRow(row => {
      row.alignment = { vertical: 'top', wrapText: true };
      row.height = ['Defect Area tersedia', 'Jenis Defect tersedia'].includes(row.getCell(1).value) ? 90 : 34;
    });

    const example = workbook.addWorksheet('Contoh Riil');
    example.addRow(headers);
    styleImportWorksheet(example, widths, 'J');
    buildQcImportSampleEntries(samples).forEach(entry => {
      example.addRow([
        entry.sample.date, entry.sample.line, entry.sample.labelWeek || '', entry.sample.model || '',
        entry.hour, entry.result, entry.quantity, entry.type || '', entry.area || '', entry.notes || 'Contoh dari data tersimpan'
      ]);
    });
    if (example.rowCount === 1) example.addRow(['Belum ada contoh data QC historis.']);
    return workbook;
  }

  function productionImportTemplateWorkbook(options = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Production Dashboard System';
    workbook.created = new Date();

    const sampleRows = Array.isArray(options.sampleRows)
      ? options.sampleRows
      : getProductionImportTemplateSampleRows();
    const defectConfig = options.defectConfig || readDefectConfig();

    const sheet = workbook.addWorksheet('Data Produksi');
    const headers = [
      'Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement',
      'QC Checked', 'Good', 'Total Defect', 'Critical', 'Major', 'Minor', 'Defect Rate',
      'Defect Area', 'Jenis Defect', 'Catatan'
    ];
    const widths = [14, 18, 14, 18, 36, 14, 14, 14, 16, 14, 16, 12, 12, 12, 14, 42, 42, 32];
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F4E78' } };
    sheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    sheet.getRow(1).height = 30;
    widths.forEach((width, index) => {
      sheet.getColumn(index + 1).width = width;
    });
    sheet.getColumn(1).numFmt = 'yyyy-mm-dd';
    [6, 7, 9, 11, 12, 13, 14].forEach(column => {
      sheet.getColumn(column).numFmt = '0';
    });
    [3, 8, 10, 15].forEach(column => {
      sheet.getCell(1, column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '7F8C8D' } };
    });
    sheet.autoFilter = { from: 'A1', to: 'R1' };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const hourlySheet = workbook.addWorksheet('Detail Per Jam');
    const hourlyHeaders = [
      'Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Jam', 'Target Manual', 'Output',
      'Selisih', 'QC Checked', 'Total Defect', 'Good', 'Defect Rate'
    ];
    const hourlyWidths = [14, 18, 14, 18, 36, 20, 16, 14, 14, 16, 16, 14, 14];
    hourlySheet.addRow(hourlyHeaders);
    hourlySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    hourlySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2F75B5' } };
    hourlySheet.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    hourlySheet.getRow(1).height = 30;
    hourlyWidths.forEach((width, index) => { hourlySheet.getColumn(index + 1).width = width; });
    hourlySheet.getColumn(1).numFmt = 'yyyy-mm-dd';
    [7, 8, 10, 11, 12].forEach(column => { hourlySheet.getColumn(column).numFmt = '0'; });
    [3, 9, 12, 13].forEach(column => {
      hourlySheet.getCell(1, column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '7F8C8D' } };
    });
    hourlySheet.autoFilter = { from: 'A1', to: 'M1' };
    hourlySheet.views = [{ state: 'frozen', ySplit: 1 }];

    const instructions = workbook.addWorksheet('Petunjuk');
    instructions.getColumn(1).width = 24;
    instructions.getColumn(2).width = 100;
    instructions.addRow(['Kolom', 'Keterangan']);
    instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };
    [
      ['Tanggal', 'Wajib. Gunakan format YYYY-MM-DD dan hanya tanggal sebelum hari ini.'],
      ['Line', 'Wajib. Nama line produksi.'],
      ['Model ID, Achievement, Good, Defect Rate', 'Boleh disalin dari report tetapi tidak dipakai saat import karena nilainya dihitung otomatis oleh sistem.'],
      ['Detail Per Jam', 'Opsional. Isi sheet Detail Per Jam jika ingin mempertahankan hasil aktual per jam. Untuk setiap summary, isi 8 jam produksi (07:00-11:00 dan 13:00-17:00). Jam istirahat 11:00 - 13:00 boleh dikosongkan.'],
      ['Kolom Detail Per Jam', 'Target Manual, Output, QC Checked, dan Total Defect wajib bilangan bulat tidak negatif. Total tiap kolom harus sama dengan nilai summary.'],
      ['Label/Week', 'Opsional. Isi label atau minggu produksi jika tersedia.'],
      ['Model', 'Wajib. Nama model produksi.'],
      ['Target, Output, QC Checked, Total Defect', 'Wajib, bilangan bulat tidak negatif. Total Defect tidak boleh lebih besar dari QC Checked.'],
      ['Critical/Major/Minor', 'Opsional. Jika diisi, jumlah ketiganya harus sama dengan Total Defect. Jika kosong, defect otomatis dianggap Minor.'],
      ['Defect Area', 'Opsional. Gunakan format Nama (Qty), dipisahkan koma. Contoh: Badan (2), Kepala (1). Total Qty harus sama dengan Total Defect.'],
      ['Jenis Defect', 'Opsional. Gunakan format Nama (Qty), dipisahkan koma. Contoh: Jahitan Terbuka (2), Kotor (1). Total Qty harus sama dengan Total Defect. Kedua kolom ini adalah rekap terpisah seperti report.'],
      ['Referensi kategori', 'Lihat sheet Referensi Defect. Daftar tersebut diambil langsung dari master kategori aplikasi saat template diunduh.'],
      ['Defect Area aktif saat ini', (defectConfig.defectAreas || []).filter(area => area.active !== false).map(area => area.name).join(', ') || 'Belum ada area defect aktif.'],
      ['Contoh data', 'Sheet Contoh Data Riil diambil dari report produksi yang sudah tersimpan. Sheet contoh tidak ikut diimport.'],
      ['Catatan', 'Opsional. Keterangan sumber data lama.'],
      ['Alur import', 'Isi sheet Data Produksi, simpan sebagai .xlsx, unggah ke aplikasi, periksa hasil review, lalu ketik IMPORT untuk konfirmasi.']
    ].forEach(row => instructions.addRow(row));
    instructions.eachRow(row => {
      row.alignment = { vertical: 'top', wrapText: true };
      row.height = row.getCell(1).value === 'Defect Area aktif saat ini' ? 90 : 30;
    });

    const example = workbook.addWorksheet('Contoh Data Riil');
    example.addRow(headers);
    example.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    example.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'A5A5A5' } };
    widths.forEach((width, index) => { example.getColumn(index + 1).width = width; });
    sampleRows.forEach(row => {
      example.addRow([
        row.date, row.line, row.modelId || '', row.labelWeek || '', row.model || '', row.target || 0,
        row.output || 0, `${row.achievement || 0}%`, row.qcChecked || 0, row.good || 0,
        row.defect || 0, row.criticalDefect || 0, row.majorDefect || 0, row.minorDefect || 0,
        `${row.defectRate || 0}%`, row.defectAreas || '-', row.defectTypes || '-',
        'Contoh otomatis dari data report tersimpan'
      ]);
    });
    if (sampleRows.length === 0) {
      example.addRow(['Belum ada data report historis yang dapat dijadikan contoh.']);
      example.mergeCells('A2:R2');
    }
    const noticeRow = example.rowCount + 2;
    example.getRow(noticeRow).values = ['Jangan unggah sheet ini. Salin baris yang diperlukan ke sheet Data Produksi.'];
    example.mergeCells(`A${noticeRow}:R${noticeRow}`);
    example.getCell(`A${noticeRow}`).font = { italic: true, color: { argb: 'C00000' } };
    example.views = [{ state: 'frozen', ySplit: 1 }];
    example.autoFilter = { from: 'A1', to: 'R1' };

    const hourlyExample = workbook.addWorksheet('Contoh Per Jam Riil');
    hourlyExample.addRow(hourlyHeaders);
    hourlyExample.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    hourlyExample.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'A5A5A5' } };
    hourlyWidths.forEach((width, index) => { hourlyExample.getColumn(index + 1).width = width; });
    sampleRows.forEach(row => {
      (row.hourlyData || []).forEach(hour => {
        const qcChecked = parseInt(hour.qcChecked) || 0;
        const defect = parseInt(hour.defect) || 0;
        hourlyExample.addRow([
          row.date, row.line, row.modelId || '', row.labelWeek || '', row.model || '', hour.hour || '',
          parseInt(hour.targetManual) || 0, parseInt(hour.output) || 0,
          (parseInt(hour.output) || 0) - (parseInt(hour.targetManual) || 0), qcChecked, defect,
          Math.max(qcChecked - defect, 0), qcChecked > 0 ? `${((defect / qcChecked) * 100).toFixed(2)}%` : '0%'
        ]);
      });
    });
    if (hourlyExample.rowCount === 1) {
      hourlyExample.addRow(['Belum ada detail per jam historis yang dapat dijadikan contoh.']);
      hourlyExample.mergeCells('A2:M2');
    }
    const hourlyNoticeRow = hourlyExample.rowCount + 2;
    hourlyExample.getRow(hourlyNoticeRow).values = ['Jangan unggah sheet ini. Salin baris yang diperlukan ke sheet Detail Per Jam.'];
    hourlyExample.mergeCells(`A${hourlyNoticeRow}:M${hourlyNoticeRow}`);
    hourlyExample.getCell(`A${hourlyNoticeRow}`).font = { italic: true, color: { argb: 'C00000' } };
    hourlyExample.autoFilter = { from: 'A1', to: 'M1' };
    hourlyExample.views = [{ state: 'frozen', ySplit: 1 }];

    const reference = workbook.addWorksheet('Referensi Defect');
    reference.addRow(['Jenis Defect', 'Severity', 'Status', '', 'Defect Area', 'Status']);
    reference.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
    reference.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } };
    const types = defectConfig.defectTypes || [];
    const areas = defectConfig.defectAreas || [];
    const referenceRows = Math.max(types.length, areas.length);
    for (let index = 0; index < referenceRows; index += 1) {
      const type = types[index];
      const area = areas[index];
      reference.addRow([
        type?.name || '', type?.severity || '', type ? (type.active !== false ? 'Aktif' : 'Nonaktif') : '', '',
        area?.name || '', area ? (area.active !== false ? 'Aktif' : 'Nonaktif') : ''
      ]);
    }
    [36, 14, 14, 4, 36, 14].forEach((width, index) => { reference.getColumn(index + 1).width = width; });
    reference.views = [{ state: 'frozen', ySplit: 1 }];
    return workbook;
  }

  return {
    productionImportTemplateWorkbook,
    qcImportTemplateWorkbook,
    sewingImportTemplateWorkbook
  };
}

module.exports = { createImportWorkbookService };
