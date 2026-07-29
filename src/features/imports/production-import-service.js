function createProductionImportService(dependencies) {
  const {
    PRODUCTION_HOURS,
    PRODUCTION_IMPORT_MAX_ROWS,
    XLSX,
    buildDefectSeverityMaps,
    createHourlyData,
    getDefectSeverity,
    getToday,
    normalizeLabelWeek,
    normalizeLabelWeekKey,
    normalizeDefectKey,
    readDefectConfig,
    readProductionSnapshotForDate,
    recalculateModelTotals
  } = dependencies;

  const QC_IMPORT_HOURS = createHourlyData(0).map(hour => hour.hour);

  function distributeImportTotal(total) {
    const value = Math.max(0, parseInt(total) || 0);
    const base = Math.floor(value / PRODUCTION_HOURS.length);
    const remainder = value % PRODUCTION_HOURS.length;
    return PRODUCTION_HOURS.map((hour, index) => ({ hour, value: base + (index < remainder ? 1 : 0) }));
  }

  function normalizeProductionImportDate(value) {
    let parts = null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      parts = {
        year: value.getUTCFullYear(),
        month: value.getUTCMonth() + 1,
        day: value.getUTCDate()
      };
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      const parsed = XLSX.SSF.parse_date_code(value);
      if (parsed) parts = { year: parsed.y, month: parsed.m, day: parsed.d };
    } else {
      const text = String(value || '').trim();
      let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (match) {
        parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
      } else {
        match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
        if (match) parts = { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) };
      }
    }

    if (!parts) return '';
    const normalized = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    const candidate = new Date(`${normalized}T00:00:00Z`);
    if (Number.isNaN(candidate.getTime())
      || candidate.getUTCFullYear() !== parts.year
      || candidate.getUTCMonth() + 1 !== parts.month
      || candidate.getUTCDate() !== parts.day) return '';
    return normalized;
  }

  function normalizeProductionImportHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  const PRODUCTION_IMPORT_HEADER_ALIASES = {
    date: ['tanggal', 'date'], line: ['line', 'linename', 'namaline'], labelWeek: ['labelweek', 'label', 'week'],
    model: ['model', 'namamodel'], target: ['target'], output: ['output', 'hasilproduksi', 'totaloutput'],
    qcChecked: ['qcdiperiksa', 'qcchecked', 'qcchecking', 'totalqc'], defect: ['totaldefect', 'defect', 'actualdefect'],
    criticalDefect: ['defectcritical', 'criticaldefect', 'critical'], majorDefect: ['defectmajor', 'majordefect', 'major'],
    minorDefect: ['defectminor', 'minordefect', 'minor'], defectAreas: ['defectarea', 'areadefect'],
    defectTypes: ['jenisdefect', 'defecttype', 'defecttypes'], notes: ['catatan', 'notes', 'keterangan']
  };

  function findProductionImportHeaderIndexes(headerRow) {
    const normalizedHeaders = headerRow.map(normalizeProductionImportHeader);
    return Object.fromEntries(Object.entries(PRODUCTION_IMPORT_HEADER_ALIASES).map(([field, aliases]) => [
      field, normalizedHeaders.findIndex(header => aliases.includes(header))
    ]));
  }

  function parseProductionImportInteger(value, label, errors, options = {}) {
    const blank = value === undefined || value === null || String(value).trim() === '';
    if (blank && options.optional) return null;
    if (blank) {
      errors.push(`${label} wajib diisi`);
      return 0;
    }

    const number = Number(value);
    if (!Number.isInteger(number) || number < 0) {
      errors.push(`${label} harus berupa bilangan bulat tidak negatif`);
      return 0;
    }
    return number;
  }

  function normalizeProductionImportText(value, label, errors, options = {}) {
    const text = String(value || '').trim();
    if (!text && options.required) errors.push(`${label} wajib diisi`);
    if (text.length > (options.maxLength || 300)) errors.push(`${label} terlalu panjang`);
    return text;
  }

  function parseProductionImportCategories(value, label, errors) {
    const text = String(value ?? '').trim();
    if (!text || text === '-') return [];
    if (text.length > 2000) {
      errors.push(`${label} terlalu panjang`);
      return [];
    }
    const entries = [];
    text.replace(/[;\n]+/g, ',').split(',').map(item => item.trim()).filter(Boolean).forEach(item => {
      const countedMatch = item.match(/^(.*?)\s*\(\s*(\d+)\s*\)$/);
      if (!countedMatch && /[()]/.test(item)) {
        errors.push(`${label} tidak valid: "${item}". Gunakan format Nama (Qty)`);
        return;
      }
      const alternateMatch = countedMatch ? null : item.match(/^(.*?)\s*[:=xX]\s*(\d+)$/);
      const name = String(countedMatch?.[1] ?? alternateMatch?.[1] ?? item).trim();
      const quantity = Number(countedMatch?.[2] ?? alternateMatch?.[2] ?? '1');
      if (!name || name.length > 300 || !Number.isInteger(quantity) || quantity <= 0) {
        errors.push(`${label} tidak valid: "${item}". Gunakan format Nama (Qty)`);
        return;
      }
      const existing = entries.find(entry => normalizeDefectKey(entry.name) === normalizeDefectKey(name));
      if (existing) existing.quantity += quantity;
      else entries.push({ name, quantity });
    });
    return entries;
  }

  function formatProductionImportCategories(entries = []) {
    return entries.length
      ? entries.map(entry => `${entry.name} (${entry.quantity})`).join(', ')
      : '-';
  }

  function productionImportCategoryTotal(entries = []) {
    return entries.reduce((total, entry) => total + (parseInt(entry.quantity) || 0), 0);
  }

  const PRODUCTION_IMPORT_HOURLY_HEADER_ALIASES = {
    date: ['tanggal', 'date'], line: ['line', 'linename', 'namaline'], labelWeek: ['labelweek', 'label', 'week'],
    model: ['model', 'namamodel'], hour: ['jam', 'hour', 'waktu'], targetManual: ['targetmanual', 'targetperjam', 'target'],
    output: ['output', 'hasilproduksi', 'totaloutput'], qcChecked: ['qcdiperiksa', 'qcchecked', 'qcchecking', 'totalqc'],
    defect: ['totaldefect', 'defect', 'actualdefect']
  };

  function findProductionImportHourlyHeaderIndexes(headerRow) {
    const normalizedHeaders = headerRow.map(normalizeProductionImportHeader);
    return Object.fromEntries(Object.entries(PRODUCTION_IMPORT_HOURLY_HEADER_ALIASES).map(([field, aliases]) => [
      field, normalizedHeaders.findIndex(header => aliases.includes(header))
    ]));
  }

  function productionImportIdentity(row) {
    return [
      String(row.date || '').trim().toLowerCase(),
      String(row.line || '').trim().toLowerCase(),
      normalizeLabelWeekKey(row.labelWeek),
      String(row.model || '').trim().toLowerCase()
    ].join('|');
  }

  function findExistingProductionImportModel(snapshot, row) {
    const models = snapshot?.lines?.[row.line]?.models || {};
    const rowLabel = normalizeLabelWeekKey(row.labelWeek);
    const rowModel = String(row.model || '').trim().toLowerCase();
    return Object.entries(models).filter(([, model]) => {
      const modelName = String(model?.model || '').trim().toLowerCase();
      const modelLabel = normalizeLabelWeekKey(model?.labelWeek);
      return modelName === rowModel && modelLabel === rowLabel;
    });
  }

  function parseProductionImportRows(sheetRows, options = {}) {
    const today = options.today || getToday();
    const getSnapshot = options.getSnapshot || readProductionSnapshotForDate;
    if (!Array.isArray(sheetRows) || sheetRows.length === 0) {
      return { rows: [], summary: { total: 0, valid: 0, invalid: 0, warnings: 0, newRecords: 0, replacements: 0, dates: 0 } };
    }

    const headerIndexes = findProductionImportHeaderIndexes(sheetRows[0] || []);
    const requiredHeaders = ['date', 'line', 'model', 'target', 'output', 'qcChecked', 'defect'];
    const missingHeaders = requiredHeaders.filter(field => headerIndexes[field] < 0);
    if (missingHeaders.length > 0) {
      const labels = {
        date: 'Tanggal', line: 'Line', model: 'Model', target: 'Target', output: 'Output',
        qcChecked: 'QC Diperiksa', defect: 'Total Defect'
      };
      const error = `Kolom wajib tidak ditemukan: ${missingHeaders.map(field => labels[field]).join(', ')}`;
      return {
        rows: [{ rowNumber: 1, action: 'invalid', errors: [error], warnings: [] }],
        summary: { total: 0, valid: 0, invalid: 1, warnings: 0, newRecords: 0, replacements: 0, dates: 0 }
      };
    }

    const dataRows = sheetRows.slice(1)
      .map((cells, index) => ({ cells, rowNumber: index + 2 }))
      .filter(({ cells }) => Array.isArray(cells) && cells.some(value => String(value ?? '').trim() !== ''));

    if (dataRows.length > PRODUCTION_IMPORT_MAX_ROWS) {
      return {
        rows: [{ rowNumber: 1, action: 'invalid', errors: [`Maksimal ${PRODUCTION_IMPORT_MAX_ROWS} baris data per import`], warnings: [] }],
        summary: { total: dataRows.length, valid: 0, invalid: dataRows.length, warnings: 0, newRecords: 0, replacements: 0, dates: 0 }
      };
    }

    const rows = dataRows.map(({ cells, rowNumber }) => {
      const errors = [];
      const warnings = [];
      const value = field => headerIndexes[field] >= 0 ? cells[headerIndexes[field]] : '';
      const date = normalizeProductionImportDate(value('date'));
      if (!date) errors.push('Tanggal tidak valid. Gunakan format YYYY-MM-DD');
      else if (date >= today) errors.push(`Tanggal harus sebelum tanggal operasional hari ini (${today})`);

      const row = {
        rowNumber,
        date,
        line: normalizeProductionImportText(value('line'), 'Line', errors, { required: true, maxLength: 100 }),
        labelWeek: normalizeLabelWeek(normalizeProductionImportText(value('labelWeek'), 'Label/Week', errors, { maxLength: 150 })),
        model: normalizeProductionImportText(value('model'), 'Model', errors, { required: true, maxLength: 300 }),
        target: parseProductionImportInteger(value('target'), 'Target', errors),
        output: parseProductionImportInteger(value('output'), 'Output', errors),
        qcChecked: parseProductionImportInteger(value('qcChecked'), 'QC Diperiksa', errors),
        defect: parseProductionImportInteger(value('defect'), 'Total Defect', errors),
        criticalDefect: parseProductionImportInteger(value('criticalDefect'), 'Defect Critical', errors, { optional: true }),
        majorDefect: parseProductionImportInteger(value('majorDefect'), 'Defect Major', errors, { optional: true }),
        minorDefect: parseProductionImportInteger(value('minorDefect'), 'Defect Minor', errors, { optional: true }),
        defectAreas: parseProductionImportCategories(value('defectAreas'), 'Defect Area', errors),
        defectTypes: parseProductionImportCategories(value('defectTypes'), 'Jenis Defect', errors),
        notes: normalizeProductionImportText(value('notes'), 'Catatan', errors, { maxLength: 500 }),
        action: 'new',
        existingModelId: '',
        errors,
        warnings
      };

      if (row.defect > row.qcChecked) errors.push('Total Defect tidak boleh lebih besar dari QC Diperiksa');
      const severityValues = [row.criticalDefect, row.majorDefect, row.minorDefect];
      if (severityValues.some(item => item !== null)) {
        const severityTotal = severityValues.reduce((total, item) => total + (item || 0), 0);
        if (severityTotal !== row.defect) errors.push('Jumlah Defect Critical, Major, dan Minor harus sama dengan Total Defect');
        row.criticalDefect = row.criticalDefect || 0;
        row.majorDefect = row.majorDefect || 0;
        row.minorDefect = row.minorDefect || 0;
      } else {
        row.criticalDefect = 0;
        row.majorDefect = 0;
        row.minorDefect = row.defect;
        if (row.defect > 0) warnings.push('Rincian severity kosong; seluruh defect akan dicatat sebagai Minor');
      }

      const defectAreaTotal = productionImportCategoryTotal(row.defectAreas);
      const defectTypeTotal = productionImportCategoryTotal(row.defectTypes);
      if (row.defectAreas.length > 0 && defectAreaTotal !== row.defect) {
        errors.push('Jumlah Qty pada Defect Area harus sama dengan Total Defect');
      }
      if (row.defectTypes.length > 0 && defectTypeTotal !== row.defect) {
        errors.push('Jumlah Qty pada Jenis Defect harus sama dengan Total Defect');
      }
      if (row.defect > 0 && row.defectAreas.length === 0 && row.defectTypes.length > 0) {
        warnings.push('Defect Area kosong; report area defect akan menampilkan -');
      }
      if (row.defect > 0 && row.defectTypes.length === 0 && row.defectAreas.length > 0) {
        warnings.push('Jenis Defect kosong; report jenis defect akan menampilkan -');
      }
      row.defectAreaSummary = formatProductionImportCategories(row.defectAreas);
      row.defectTypeSummary = formatProductionImportCategories(row.defectTypes);
      return row;
    });

    const rowsByIdentity = new Map();
    rows.forEach(row => {
      if (!row.date || !row.line || !row.model) return;
      const key = productionImportIdentity(row);
      const duplicates = rowsByIdentity.get(key) || [];
      duplicates.push(row);
      rowsByIdentity.set(key, duplicates);
    });
    rowsByIdentity.forEach(duplicates => {
      if (duplicates.length < 2) return;
      duplicates.forEach(row => row.errors.push('Data tanggal, line, label/week, dan model terduplikasi di file'));
    });

    const snapshots = new Map();
    rows.forEach(row => {
      if (row.errors.length > 0 || !row.date) {
        row.action = 'invalid';
        return;
      }
      if (!snapshots.has(row.date)) snapshots.set(row.date, getSnapshot(row.date));
      const matches = findExistingProductionImportModel(snapshots.get(row.date), row);
      if (matches.length > 1) {
        row.errors.push('Ada lebih dari satu data existing dengan identitas yang sama; rapikan data sebelum import');
        row.action = 'invalid';
      } else if (matches.length === 1) {
        row.action = 'replace';
        row.existingModelId = matches[0][0];
        row.warnings.push('Data existing akan diganti setelah konfirmasi');
      }
    });

    return { rows, summary: summarizeProductionImportRows(rows) };
  }

  function summarizeProductionImportRows(rows = []) {
    return {
      total: rows.length,
      valid: rows.filter(row => row.errors.length === 0).length,
      invalid: rows.filter(row => row.errors.length > 0).length,
      warnings: rows.reduce((total, row) => total + row.warnings.length, 0),
      newRecords: rows.filter(row => row.errors.length === 0 && row.action === 'new').length,
      replacements: rows.filter(row => row.errors.length === 0 && row.action === 'replace').length,
      dates: new Set(rows.filter(row => row.errors.length === 0).map(row => row.date)).size
    };
  }

  function parseProductionImportHourlySheet(sheetRows, summaryRows) {
    if (!Array.isArray(sheetRows) || sheetRows.length === 0) return { issues: [] };
    const headerIndexes = findProductionImportHourlyHeaderIndexes(sheetRows[0] || []);
    const requiredHeaders = ['date', 'line', 'model', 'hour', 'targetManual', 'output', 'qcChecked', 'defect'];
    const missingHeaders = requiredHeaders.filter(field => headerIndexes[field] < 0);
    if (missingHeaders.length > 0) {
      return {
        issues: [{
          rowNumber: 'Detail Per Jam!1',
          errors: [`Kolom wajib Detail Per Jam tidak ditemukan: ${missingHeaders.join(', ')}`],
          warnings: []
        }]
      };
    }

    const dataRows = sheetRows.slice(1)
      .map((cells, index) => ({ cells, rowNumber: index + 2 }))
      .filter(({ cells }) => Array.isArray(cells) && cells.some(value => String(value ?? '').trim() !== ''));
    if (dataRows.length > PRODUCTION_IMPORT_MAX_ROWS * 9) {
      return {
        issues: [{
          rowNumber: 'Detail Per Jam!1',
          errors: [`Maksimal ${PRODUCTION_IMPORT_MAX_ROWS * 9} baris Detail Per Jam per import`],
          warnings: []
        }]
      };
    }

    const rows = dataRows.map(({ cells, rowNumber }) => {
      const errors = [];
      const value = field => cells[headerIndexes[field]];
      const date = normalizeProductionImportDate(value('date'));
      if (!date) errors.push('Tanggal tidak valid. Gunakan format YYYY-MM-DD');
      const row = {
        rowNumber,
        date,
        line: normalizeProductionImportText(value('line'), 'Line', errors, { required: true, maxLength: 100 }),
        labelWeek: normalizeLabelWeek(normalizeProductionImportText(value('labelWeek'), 'Label/Week', errors, { maxLength: 150 })),
        model: normalizeProductionImportText(value('model'), 'Model', errors, { required: true, maxLength: 300 }),
        hour: normalizeProductionImportText(value('hour'), 'Jam', errors, { required: true, maxLength: 50 }),
        targetManual: parseProductionImportInteger(value('targetManual'), 'Target Manual', errors),
        output: parseProductionImportInteger(value('output'), 'Output', errors),
        qcChecked: parseProductionImportInteger(value('qcChecked'), 'QC Checked', errors),
        defect: parseProductionImportInteger(value('defect'), 'Total Defect', errors),
        errors,
        warnings: []
      };
      if (!createHourlyData(0).some(hour => hour.hour === row.hour)) {
        errors.push(`Jam tidak dikenal: ${row.hour}`);
      }
      if (row.defect > row.qcChecked) errors.push('Total Defect tidak boleh lebih besar dari QC Checked');
      row.selisih = row.output - row.targetManual;
      return row;
    });

    const summaryByIdentity = new Map(summaryRows.map(row => [productionImportIdentity(row), row]));
    const grouped = new Map();
    rows.forEach(row => {
      const key = productionImportIdentity(row);
      const existing = grouped.get(key) || [];
      existing.push(row);
      grouped.set(key, existing);
    });
    const issues = [];
    rows.forEach(row => {
      const summary = summaryByIdentity.get(productionImportIdentity(row));
      if (!summary) {
        issues.push({
          rowNumber: `Detail Per Jam!${row.rowNumber}`,
          errors: [`Tidak ada baris summary yang cocok untuk tanggal, line, label/week, dan model`].concat(row.errors),
          warnings: []
        });
      }
    });

    grouped.forEach((hourRows, key) => {
      const summary = summaryByIdentity.get(key);
      if (!summary) return;
      if (hourRows.length !== new Set(hourRows.map(row => row.hour)).size) {
        summary.errors.push('Detail Per Jam memiliki jam yang terduplikasi untuk identitas yang sama');
      }
      hourRows.forEach(row => {
        if (row.errors.length > 0) summary.errors.push(`Detail Per Jam baris ${row.rowNumber}: ${row.errors.join('; ')}`);
      });
      if (hourRows.some(row => row.errors.length > 0)) return;

      const expectedHours = PRODUCTION_HOURS;
      const detailByHour = new Map(hourRows.map(row => [row.hour, row]));
      const missingHours = expectedHours.filter(hour => !detailByHour.has(hour));
      if (missingHours.length > 0) {
        summary.errors.push(`Detail Per Jam belum lengkap. Jam yang belum diisi: ${missingHours.join(', ')}`);
        return;
      }
      const hourlyData = createHourlyData(summary.target).map(hour => {
        const detail = detailByHour.get(hour.hour);
        return detail
          ? { hour: detail.hour, targetManual: detail.targetManual, output: detail.output, qcChecked: detail.qcChecked, defect: detail.defect, selisih: detail.selisih }
          : hour;
      });
      const totals = hourlyData.reduce((total, hour) => ({
        target: total.target + hour.targetManual,
        output: total.output + hour.output,
        qcChecked: total.qcChecked + hour.qcChecked,
        defect: total.defect + hour.defect
      }), { target: 0, output: 0, qcChecked: 0, defect: 0 });
      [['target', 'Target'], ['output', 'Output'], ['qcChecked', 'QC Checked'], ['defect', 'Total Defect']].forEach(([field, label]) => {
        if (totals[field] !== summary[field]) summary.errors.push(`Total ${label} pada Detail Per Jam harus sama dengan nilai summary`);
      });
      if (summary.errors.length === 0) summary.hourlyData = hourlyData;
    });

    return { issues };
  }

  function parseProductionImportWorkbook(buffer, options = {}) {
    // Keep Excel dates as serial numbers so calendar dates are not shifted by timezone conversion.
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const sheetName = workbook.SheetNames.find(name => normalizeProductionImportHeader(name) === 'dataproduksi')
      || workbook.SheetNames[0];
    if (!sheetName) throw new Error('Workbook tidak memiliki worksheet');
    const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    const parsed = parseProductionImportRows(sheetRows, options);
    const hourlySheetName = workbook.SheetNames.find(name => normalizeProductionImportHeader(name) === 'detailperjam');
    if (hourlySheetName) {
      const hourlyRows = XLSX.utils.sheet_to_json(workbook.Sheets[hourlySheetName], { header: 1, defval: '', raw: true });
      const hourlyResult = parseProductionImportHourlySheet(hourlyRows, parsed.rows);
      hourlyResult.issues.forEach(issue => parsed.rows.push({ ...issue, action: 'invalid' }));
      parsed.summary = summarizeProductionImportRows(parsed.rows);
    }
    return parsed;
  }

  function pairProductionImportCategories(types = [], areas = [], totalDefect = 0) {
    const total = Math.max(parseInt(totalDefect) || 0, 0);
    if (total === 0) return [];

    const remainingTypes = (types.length ? types : [{ name: '', quantity: total }])
      .map(entry => ({ ...entry, quantity: parseInt(entry.quantity) || 0 }));
    const remainingAreas = (areas.length ? areas : [{ name: '', quantity: total }])
      .map(entry => ({ ...entry, quantity: parseInt(entry.quantity) || 0 }));
    const pairs = [];
    let typeIndex = 0;
    let areaIndex = 0;

    while (typeIndex < remainingTypes.length && areaIndex < remainingAreas.length) {
      const type = remainingTypes[typeIndex];
      const area = remainingAreas[areaIndex];
      const quantity = Math.min(type.quantity, area.quantity);
      if (quantity > 0) pairs.push({ type: type.name, area: area.name, quantity });
      type.quantity -= quantity;
      area.quantity -= quantity;
      if (type.quantity === 0) typeIndex += 1;
      if (area.quantity === 0) areaIndex += 1;
    }
    return pairs;
  }

  function applyProductionImportSeverities(details = [], row = {}) {
    const severityQueue = [
      { severity: 'critical', quantity: parseInt(row.criticalDefect) || 0 },
      { severity: 'major', quantity: parseInt(row.majorDefect) || 0 },
      { severity: 'minor', quantity: parseInt(row.minorDefect) || 0 }
    ];
    const result = [];
    let severityIndex = 0;

    details.forEach(detail => {
      let remaining = parseInt(detail.quantity) || 0;
      while (remaining > 0 && severityIndex < severityQueue.length) {
        const severity = severityQueue[severityIndex];
        if (severity.quantity === 0) {
          severityIndex += 1;
          continue;
        }
        const quantity = Math.min(remaining, severity.quantity);
        result.push({ ...detail, quantity, severity: severity.severity });
        remaining -= quantity;
        severity.quantity -= quantity;
      }
    });
    return result;
  }

  function distributeProductionImportDefectDetails(hourlyData, details) {
    const remainingDetails = details.map(detail => ({ ...detail, quantity: parseInt(detail.quantity) || 0 }));
    let detailIndex = 0;
    hourlyData.forEach(hour => {
      let remainingHourDefect = parseInt(hour.defect) || 0;
      hour.defectDetails = [];
      while (remainingHourDefect > 0 && detailIndex < remainingDetails.length) {
        const detail = remainingDetails[detailIndex];
        if (detail.quantity === 0) {
          detailIndex += 1;
          continue;
        }
        const quantity = Math.min(remainingHourDefect, detail.quantity);
        hour.defectDetails.push({ ...detail, quantity });
        remainingHourDefect -= quantity;
        detail.quantity -= quantity;
      }
    });
  }

  function buildImportedProductionModel(row, modelId) {
    const hourlyData = Array.isArray(row.hourlyData)
      ? row.hourlyData.map(hour => ({
        hour: hour.hour,
        output: parseInt(hour.output) || 0,
        defect: parseInt(hour.defect) || 0,
        qcChecked: parseInt(hour.qcChecked) || 0,
        targetManual: parseInt(hour.targetManual) || 0,
        selisih: (parseInt(hour.output) || 0) - (parseInt(hour.targetManual) || 0)
      }))
      : createHourlyData(row.target);
    const productiveIndexes = hourlyData
      .map((hour, index) => ({ hour, index }))
      .filter(item => item.hour.hour !== '11:00 - 13:00');

    if (!Array.isArray(row.hourlyData)) {
      const outputs = distributeImportTotal(row.output);
      const qcChecked = distributeImportTotal(row.qcChecked);
      const defects = distributeImportTotal(row.defect);
      productiveIndexes.forEach((item, productionIndex) => {
        item.hour.output = outputs[productionIndex].value;
        item.hour.qcChecked = qcChecked[productionIndex].value;
        item.hour.defect = defects[productionIndex].value;
        item.hour.selisih = item.hour.output - item.hour.targetManual;
      });
    }

    const categoryDetails = pairProductionImportCategories(row.defectTypes, row.defectAreas, row.defect);
    const defectDetails = categoryDetails.length > 0
      ? applyProductionImportSeverities(categoryDetails, row)
      : [
        { type: 'Import historis - Critical', area: 'Data lama', quantity: row.criticalDefect, severity: 'critical' },
        { type: 'Import historis - Major', area: 'Data lama', quantity: row.majorDefect, severity: 'major' },
        { type: 'Import historis - Minor', area: 'Data lama', quantity: row.minorDefect, severity: 'minor' }
      ].filter(detail => detail.quantity > 0);
    distributeProductionImportDefectDetails(hourlyData, defectDetails);

    return {
      id: modelId,
      labelWeek: row.labelWeek,
      model: row.model,
      date: row.date,
      target: row.target,
      targetPerHour: Math.round(row.target / PRODUCTION_HOURS.length),
      outputDay: row.output,
      qcChecking: row.qcChecked,
      actualDefect: row.defect,
      defectRatePercentage: row.qcChecked > 0 ? parseFloat(((row.defect / row.qcChecked) * 100).toFixed(2)) : 0,
      hourly_data: hourlyData,
      operators: [],
      notes: row.notes,
      importedHistoricalData: true
    };
  }

  function readImportSheetRows(buffer, normalizedSheetNames) {
    // Keep Excel dates as serial numbers so calendar dates are not shifted by timezone conversion.
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
    const acceptedNames = Array.isArray(normalizedSheetNames) ? normalizedSheetNames : [normalizedSheetNames];
    const sheetName = workbook.SheetNames.find(name => acceptedNames.includes(normalizeProductionImportHeader(name)))
      || workbook.SheetNames[0];
    if (!sheetName) throw new Error('Workbook tidak memiliki worksheet');
    return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
  }

  function parseSewingImportWorkbook(buffer, options = {}) {
    const today = options.today || getToday();
    const getSnapshot = options.getSnapshot || readProductionSnapshotForDate;
    const sheetRows = readImportSheetRows(buffer, ['dataproduksi', 'datasewing']);
    const aliases = {
      date: ['tanggal', 'date'], line: ['line', 'namaline'], labelWeek: ['labelweek', 'label', 'week'],
      model: ['model', 'namamodel'], hour: ['jam', 'hour'], targetManual: ['targetmanual', 'targetperjam', 'target'],
      output: ['output', 'hasilproduksi'], notes: ['catatan', 'notes', 'keterangan']
    };
    const normalizedHeaders = (sheetRows[0] || []).map(normalizeProductionImportHeader);
    const indexes = Object.fromEntries(Object.entries(aliases).map(([field, values]) => [
      field, normalizedHeaders.findIndex(header => values.includes(header))
    ]));
    const required = ['date', 'line', 'model', 'hour', 'targetManual', 'output'];
    const missing = required.filter(field => indexes[field] < 0);
    if (missing.length > 0) {
      return {
        rows: [{ rowNumber: 1, action: 'invalid', errors: [`Kolom wajib tidak ditemukan: ${missing.join(', ')}`], warnings: [] }],
        summary: summarizeProductionImportRows([{ rowNumber: 1, action: 'invalid', errors: ['Header tidak lengkap'], warnings: [] }])
      };
    }

    const rawRows = sheetRows.slice(1)
      .map((cells, index) => ({ cells, rowNumber: index + 2 }))
      .filter(({ cells }) => cells.some(value => String(value ?? '').trim() !== ''));
    if (rawRows.length > PRODUCTION_IMPORT_MAX_ROWS * PRODUCTION_HOURS.length) {
      const row = { rowNumber: 1, action: 'invalid', errors: ['Jumlah baris Data Produksi melebihi batas'], warnings: [] };
      return { rows: [row], summary: summarizeProductionImportRows([row]) };
    }

    const parsedHours = rawRows.map(({ cells, rowNumber }) => {
      const errors = [];
      const value = field => indexes[field] >= 0 ? cells[indexes[field]] : '';
      const date = normalizeProductionImportDate(value('date'));
      if (!date) errors.push('Tanggal tidak valid. Gunakan format YYYY-MM-DD');
      else if (date >= today) errors.push(`Tanggal harus sebelum tanggal operasional hari ini (${today})`);
      const row = {
        rowNumber,
        date,
        line: normalizeProductionImportText(value('line'), 'Line', errors, { required: true, maxLength: 100 }),
        labelWeek: normalizeLabelWeek(normalizeProductionImportText(value('labelWeek'), 'Label/Week', errors, { maxLength: 150 })),
        model: normalizeProductionImportText(value('model'), 'Model', errors, { required: true, maxLength: 300 }),
        hour: normalizeProductionImportText(value('hour'), 'Jam', errors, { required: true, maxLength: 50 }),
        targetManual: parseProductionImportInteger(value('targetManual'), 'Target Manual', errors),
        output: parseProductionImportInteger(value('output'), 'Output', errors),
        notes: normalizeProductionImportText(value('notes'), 'Catatan', errors, { maxLength: 500 }),
        errors
      };
      if (!PRODUCTION_HOURS.includes(row.hour)) errors.push(`Jam tidak dikenal: ${row.hour}`);
      return row;
    });

    const grouped = new Map();
    parsedHours.forEach(hour => {
      const key = productionImportIdentity(hour);
      const items = grouped.get(key) || [];
      items.push(hour);
      grouped.set(key, items);
    });
    const snapshots = new Map();
    const rows = Array.from(grouped.values()).map(hours => {
      const first = hours[0];
      const errors = hours.flatMap(hour => hour.errors.map(error => `Baris ${hour.rowNumber}: ${error}`));
      const warnings = [];
      if (hours.length !== new Set(hours.map(hour => hour.hour)).size) errors.push('Jam produksi terduplikasi');
      const missingHours = PRODUCTION_HOURS.filter(hour => !hours.some(item => item.hour === hour));
      if (missingHours.length > 0) errors.push(`Jam produksi belum lengkap: ${missingHours.join(', ')}`);
      const hourlyData = createHourlyData(0).map(hour => {
        const imported = hours.find(item => item.hour === hour.hour);
        return imported
          ? { hour: imported.hour, targetManual: imported.targetManual, output: imported.output, selisih: imported.output - imported.targetManual, qcChecked: 0, defect: 0 }
          : hour;
      });
      const target = hourlyData.reduce((total, hour) => total + hour.targetManual, 0);
      const output = hourlyData.reduce((total, hour) => total + hour.output, 0);
      const row = {
        rowNumber: first.rowNumber,
        date: first.date,
        line: first.line,
        labelWeek: first.labelWeek,
        model: first.model,
        target,
        output,
        qcChecked: null,
        defect: null,
        hourlyData,
        notes: hours.map(hour => hour.notes).find(Boolean) || '',
        action: 'new',
        existingModelId: '',
        errors,
        warnings,
        importKind: 'sewing'
      };
      if (errors.length === 0 && row.date) {
        if (!snapshots.has(row.date)) snapshots.set(row.date, getSnapshot(row.date));
        const matches = findExistingProductionImportModel(snapshots.get(row.date), row);
        if (matches.length > 1) {
          row.errors.push('Ada lebih dari satu model existing dengan identitas yang sama');
        } else if (matches.length === 1) {
          row.action = 'replace';
          row.existingModelId = matches[0][0];
          row.warnings.push('Data produksi existing akan diperbarui; data QC tetap dipertahankan');
        }
      }
      if (row.errors.length > 0) row.action = 'invalid';
      return row;
    });
    if (rows.length > PRODUCTION_IMPORT_MAX_ROWS) {
      const row = { rowNumber: 1, action: 'invalid', errors: [`Maksimal ${PRODUCTION_IMPORT_MAX_ROWS} model per import`], warnings: [], importKind: 'sewing' };
      return { rows: [row], summary: summarizeProductionImportRows([row]) };
    }
    return { rows, summary: summarizeProductionImportRows(rows) };
  }

  function normalizeQcImportResult(value) {
    const result = String(value || '').trim().toLowerCase();
    if (['good', 'baik', 'ok'].includes(result)) return 'good';
    if (['defect', 'reject', 'ng'].includes(result)) return 'defect';
    return '';
  }

  function parseQcImportWorkbook(buffer, options = {}) {
    const today = options.today || getToday();
    const getSnapshot = options.getSnapshot || readProductionSnapshotForDate;
    const defectConfig = options.defectConfig || readDefectConfig();
    const severityMaps = buildDefectSeverityMaps(defectConfig);
    const sheetRows = readImportSheetRows(buffer, 'dataqc');
    const aliases = {
      date: ['tanggal', 'date'], line: ['line', 'namaline'], labelWeek: ['labelweek', 'label', 'week'],
      model: ['model', 'namamodel'], hour: ['jam', 'hour'], result: ['hasilqc', 'hasil', 'result'],
      quantity: ['qty', 'quantity', 'jumlah'], type: ['jenisdefect', 'defecttype'], area: ['defectarea', 'areadefect'],
      notes: ['catatan', 'notes', 'keterangan']
    };
    const normalizedHeaders = (sheetRows[0] || []).map(normalizeProductionImportHeader);
    const indexes = Object.fromEntries(Object.entries(aliases).map(([field, values]) => [
      field, normalizedHeaders.findIndex(header => values.includes(header))
    ]));
    const required = ['date', 'line', 'model', 'hour', 'result', 'quantity', 'type', 'area'];
    const missing = required.filter(field => indexes[field] < 0);
    if (missing.length > 0) {
      const row = { rowNumber: 1, action: 'invalid', errors: [`Kolom wajib tidak ditemukan: ${missing.join(', ')}`], warnings: [], importKind: 'qc' };
      return { rows: [row], summary: summarizeProductionImportRows([row]) };
    }

    const validTypes = new Map((defectConfig.defectTypes || [])
      .filter(type => type.active !== false)
      .map(type => [normalizeDefectKey(type.name), type]));
    const validAreas = new Map((defectConfig.defectAreas || [])
      .filter(area => area.active !== false)
      .map(area => [normalizeDefectKey(area.name), area]));
    const rawRows = sheetRows.slice(1)
      .map((cells, index) => ({ cells, rowNumber: index + 2 }))
      .filter(({ cells }) => cells.some(value => String(value ?? '').trim() !== ''));
    if (rawRows.length > PRODUCTION_IMPORT_MAX_ROWS * PRODUCTION_HOURS.length) {
      const row = { rowNumber: 1, action: 'invalid', errors: ['Jumlah baris Data QC melebihi batas'], warnings: [], importKind: 'qc' };
      return { rows: [row], summary: summarizeProductionImportRows([row]) };
    }

    const parsedEntries = rawRows.map(({ cells, rowNumber }) => {
      const errors = [];
      const warnings = [];
      const value = field => indexes[field] >= 0 ? cells[indexes[field]] : '';
      const date = normalizeProductionImportDate(value('date'));
      if (!date) errors.push('Tanggal tidak valid. Gunakan format YYYY-MM-DD');
      else if (date >= today) errors.push(`Tanggal harus sebelum tanggal operasional hari ini (${today})`);
      const result = normalizeQcImportResult(value('result'));
      if (!result) errors.push('Hasil QC harus Good atau Defect');
      const typeText = String(value('type') || '').trim();
      const areaText = String(value('area') || '').trim();
      const typeConfig = validTypes.get(normalizeDefectKey(typeText));
      const areaConfig = validAreas.get(normalizeDefectKey(areaText));
      const entry = {
        rowNumber,
        date,
        line: normalizeProductionImportText(value('line'), 'Line', errors, { required: true, maxLength: 100 }),
        labelWeek: normalizeLabelWeek(normalizeProductionImportText(value('labelWeek'), 'Label/Week', errors, { maxLength: 150 })),
        model: normalizeProductionImportText(value('model'), 'Model', errors, { required: true, maxLength: 300 }),
        hour: normalizeProductionImportText(value('hour'), 'Jam', errors, { required: true, maxLength: 50 }),
        result,
        quantity: parseProductionImportInteger(value('quantity'), 'Qty', errors),
        type: typeText,
        area: areaText,
        notes: normalizeProductionImportText(value('notes'), 'Catatan', errors, { maxLength: 500 }),
        errors,
        warnings
      };
      if (entry.quantity === 0) errors.push('Qty harus lebih dari 0');
      if (!QC_IMPORT_HOURS.includes(entry.hour)) errors.push(`Jam tidak dikenal: ${entry.hour}`);
      if (result === 'defect') {
        if (!typeText || !typeConfig) errors.push('Jenis Defect wajib dipilih dari daftar aplikasi');
        if (!areaText || !areaConfig) errors.push('Defect Area wajib dipilih dari daftar aplikasi');
        entry.severity = getDefectSeverity(typeText, severityMaps);
      } else {
        entry.type = '';
        entry.area = '';
        entry.severity = '';
        if (typeText || areaText) warnings.push('Jenis dan area defect pada hasil Good diabaikan');
      }
      return entry;
    });

    const grouped = new Map();
    parsedEntries.forEach(entry => {
      const key = productionImportIdentity(entry);
      const items = grouped.get(key) || [];
      items.push(entry);
      grouped.set(key, items);
    });
    const snapshots = new Map();
    const rows = Array.from(grouped.values()).map(entries => {
      const first = entries[0];
      const errors = entries.flatMap(entry => entry.errors.map(error => `Baris ${entry.rowNumber}: ${error}`));
      const warnings = entries.flatMap(entry => entry.warnings.map(warning => `Baris ${entry.rowNumber}: ${warning}`));
      const hourlyQcData = createHourlyData(0).map(hour => {
        const hourEntries = entries.filter(entry => entry.hour === hour.hour && entry.errors.length === 0);
        const qcChecked = hourEntries.reduce((total, entry) => total + entry.quantity, 0);
        const defectEntries = hourEntries.filter(entry => entry.result === 'defect');
        return {
          hour: hour.hour,
          qcChecked,
          defect: defectEntries.reduce((total, entry) => total + entry.quantity, 0),
          defectDetails: defectEntries.map(entry => ({
            type: entry.type,
            area: entry.area,
            quantity: entry.quantity,
            severity: entry.severity,
            notes: entry.notes
          }))
        };
      });
      const defectDetails = hourlyQcData.flatMap(hour => hour.defectDetails);
      const defectTypes = [];
      const defectAreas = [];
      defectDetails.forEach(detail => {
        const type = defectTypes.find(item => normalizeDefectKey(item.name) === normalizeDefectKey(detail.type));
        if (type) type.quantity += detail.quantity;
        else defectTypes.push({ name: detail.type, quantity: detail.quantity });
        const area = defectAreas.find(item => normalizeDefectKey(item.name) === normalizeDefectKey(detail.area));
        if (area) area.quantity += detail.quantity;
        else defectAreas.push({ name: detail.area, quantity: detail.quantity });
      });
      const row = {
        rowNumber: first.rowNumber,
        date: first.date,
        line: first.line,
        labelWeek: first.labelWeek,
        model: first.model,
        target: null,
        output: null,
        qcChecked: hourlyQcData.reduce((total, hour) => total + hour.qcChecked, 0),
        defect: hourlyQcData.reduce((total, hour) => total + hour.defect, 0),
        defectTypeSummary: formatProductionImportCategories(defectTypes),
        defectAreaSummary: formatProductionImportCategories(defectAreas),
        hourlyQcData,
        action: 'replace',
        existingModelId: '',
        errors,
        warnings,
        importKind: 'qc'
      };
      if (errors.length === 0 && row.date) {
        if (!snapshots.has(row.date)) snapshots.set(row.date, getSnapshot(row.date));
        const matches = findExistingProductionImportModel(snapshots.get(row.date), row);
        if (matches.length === 0) {
          row.errors.push('Data produksi belum ditemukan. Input data produksi terlebih dahulu');
        } else if (matches.length > 1) {
          row.errors.push('Ada lebih dari satu model existing dengan identitas yang sama');
        } else {
          row.existingModelId = matches[0][0];
          row.target = matches[0][1].target || 0;
          row.output = matches[0][1].outputDay || 0;
          row.warnings.push('Data QC existing untuk model ini akan diganti');
        }
      }
      if (row.errors.length > 0) row.action = 'invalid';
      return row;
    });
    return { rows, summary: summarizeProductionImportRows(rows) };
  }

  function buildImportedSewingModel(row, modelId, existingModel = null) {
    const existingHours = new Map((existingModel?.hourly_data || []).map(hour => [hour.hour, hour]));
    const hourlyData = row.hourlyData.map(hour => {
      const existing = existingHours.get(hour.hour) || {};
      return {
        ...existing,
        hour: hour.hour,
        targetManual: hour.targetManual,
        output: hour.output,
        selisih: hour.output - hour.targetManual,
        qcChecked: parseInt(existing.qcChecked) || 0,
        defect: parseInt(existing.defect) || 0,
        defectDetails: existing.defectDetails || []
      };
    });
    const model = {
      ...(existingModel || {}),
      id: modelId,
      labelWeek: row.labelWeek,
      model: row.model,
      date: row.date,
      target: row.target,
      targetPerHour: Math.round(row.target / PRODUCTION_HOURS.length),
      outputDay: row.output,
      hourly_data: hourlyData,
      operators: existingModel?.operators || [],
      notes: row.notes || existingModel?.notes || '',
      importedHistoricalData: true
    };
    recalculateModelTotals(model);
    return model;
  }

  function applyImportedQcData(model, row) {
    const qcByHour = new Map(row.hourlyQcData.map(hour => [hour.hour, hour]));
    (model.hourly_data || []).forEach(hour => {
      const imported = qcByHour.get(hour.hour) || { qcChecked: 0, defect: 0, defectDetails: [] };
      hour.qcChecked = imported.qcChecked;
      hour.defect = imported.defect;
      hour.defectDetails = imported.defectDetails;
    });
    delete model.qcChecks;
    model.importedHistoricalQcData = true;
    recalculateModelTotals(model);
    return model;
  }

  return {
    QC_IMPORT_HOURS,
    applyImportedQcData,
    buildImportedProductionModel,
    buildImportedSewingModel,
    parseProductionImportRows,
    parseProductionImportWorkbook,
    parseQcImportWorkbook,
    parseSewingImportWorkbook
  };
}

module.exports = { createProductionImportService };
