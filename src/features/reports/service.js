const { createPdfReport } = require('../../shared/pdf');

function createReportService(dependencies) {
  const {
    ExcelJS,
    buildDefectSeverityMaps,
    calculateDefectSeverityBreakdown,
    ensureLineActiveModels,
    getAvailableHistoryDates,
    getDefectSeverity,
    getLatestSnapshotForDate,
    getToday,
    isValidDateInput,
    parseNonNegativeInteger,
    readBrandingSettings = () => ({}),
    readDefectConfig,
    readProductionData,
    readSnapshotData
  } = dependencies;

  function addToCounter(counter, key, amount = 1) {
    const label = String(key || '').trim();
    if (!label) return;
    counter[label] = (counter[label] || 0) + (parseInt(amount) || 0 || 1);
  }

  function qcCheckQuantity(check) {
    const quantity = parseNonNegativeInteger(check?.quantity, 1);
    return Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  }

  function formatCounter(counter) {
    const items = Object.entries(counter || {})
      .filter(([, count]) => (parseInt(count) || 0) > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    return items.length ? items.map(([name, count]) => `${name} (${count})`).join(', ') : '-';
  }

  function summarizeDefectCategoriesFromDetails(details = []) {
    const typeCounts = {};
    const areaCounts = {};

    (details || []).forEach(detail => {
      const quantity = parseInt(detail.quantity) || 1;
      addToCounter(typeCounts, detail.type, quantity);
      addToCounter(areaCounts, detail.area, quantity);
    });

    return {
      types: formatCounter(typeCounts),
      areas: formatCounter(areaCounts)
    };
  }

  function getDefectSeverityLabel(type, config = readDefectConfig()) {
    const severity = getDefectSeverity(type, buildDefectSeverityMaps(config));
    return severity.charAt(0).toUpperCase() + severity.slice(1);
  }

  function summarizeModelDefectCategories(model = {}) {
    const typeCounts = {};
    const areaCounts = {};

    (model.hourly_data || []).forEach(hour => {
      (hour.defectDetails || []).forEach(detail => {
        const quantity = parseInt(detail.quantity) || 1;
        addToCounter(typeCounts, detail.type, quantity);
        addToCounter(areaCounts, detail.area, quantity);
      });
    });

    (model.qcChecks || [])
      .filter(check => check.result === 'defect')
      .forEach(check => {
        addToCounter(typeCounts, check.type, qcCheckQuantity(check));
        addToCounter(areaCounts, check.area, qcCheckQuantity(check));
      });

    return {
      types: formatCounter(typeCounts),
      areas: formatCounter(areaCounts)
    };
  }

  // Keep the browser report and every Excel export on the same dated dataset.
  function filterProductionDataByDate(data, date) {
    const lines = {};

    Object.entries(data?.lines || {}).forEach(([lineName, line]) => {
      const models = Object.fromEntries(
        Object.entries(line.models || {}).filter(([, model]) => model?.date === date)
      );

      if (Object.keys(models).length > 0) {
        lines[lineName] = { ...line, models };
      }
    });

    return { ...data, lines };
  }

  function filterProductionDataByLine(data, lineName) {
    const selectedLine = String(lineName || '').trim();
    if (!selectedLine) return { ...data, lines: { ...(data?.lines || {}) } };

    const line = data?.lines?.[selectedLine];
    return {
      ...data,
      lines: line ? { [selectedLine]: line } : {},
      activeLine: line ? selectedLine : ''
    };
  }

  function isValidDateRange(startDate, endDate) {
    return isValidDateInput(startDate)
      && isValidDateInput(endDate)
      && startDate <= endDate;
  }

  function getReportDatesInRange(startDate, endDate) {
    const dates = new Set(getAvailableHistoryDates());
    dates.add(getToday());

    return Array.from(dates)
      .filter(date => date >= startDate && date <= endDate)
      .sort((a, b) => a.localeCompare(b));
  }

  function readProductionSnapshotForDate(date) {
    const snapshot = getLatestSnapshotForDate(date);
    return readSnapshotData(snapshot) || (date === getToday() ? readProductionData() : null);
  }

  function mergeProductionSnapshotsByDate(snapshots = []) {
    const mergedData = { lines: {}, activeLine: '' };

    snapshots.forEach(({ date, data }) => {
      const filteredData = filterProductionDataByDate(data, date);

      Object.entries(filteredData.lines || {}).forEach(([lineName, line]) => {
        if (!mergedData.lines[lineName]) {
          mergedData.lines[lineName] = { models: {}, activeModels: [] };
        }

        Object.entries(line.models || {}).forEach(([modelId, model]) => {
          const reportModelKey = `${date}::${modelId}`;
          mergedData.lines[lineName].models[reportModelKey] = {
            ...model,
            reportModelId: modelId
          };
          mergedData.lines[lineName].activeModels.push(reportModelKey);
        });
      });
    });

    return mergedData;
  }

  function buildDateRangeProductionData(startDate, endDate) {
    const snapshots = getReportDatesInRange(startDate, endDate)
      .map(date => ({ date, data: readProductionSnapshotForDate(date) }))
      .filter(snapshot => snapshot.data);

    return mergeProductionSnapshotsByDate(snapshots);
  }

  function buildProductionReportRows(data) {
    return Object.entries(data?.lines || {}).flatMap(([lineName, line]) =>
      Object.entries(line.models || {}).map(([modelId, model]) => {
        const defectBreakdown = calculateDefectSeverityBreakdown(model);
        const defectCategories = summarizeModelDefectCategories(model);
        const target = model.target || 0;
        const output = model.outputDay || 0;
        const defect = model.actualDefect || 0;
        const qcChecked = model.qcChecking || 0;
        return {
          line: lineName,
          modelId: model.reportModelId || modelId,
          labelWeek: model.labelWeek,
          model: model.model,
          date: model.date,
          target,
          output,
          achievement: target > 0 ? parseFloat(((output / target) * 100).toFixed(2)) : 0,
          defect,
          criticalDefect: defectBreakdown.critical.count,
          majorDefect: defectBreakdown.major.count,
          minorDefect: defectBreakdown.minor.count,
          qcChecked,
          good: Math.max(qcChecked - defect, 0),
          defectRate: model.defectRatePercentage || 0,
          defectAreas: defectCategories.areas,
          defectTypes: defectCategories.types
        };
      })
    );
  }

  function buildDateReportRows(data, date) {
    const filteredData = filterProductionDataByDate(data, date);
    return buildProductionReportRows(filteredData);
  }

  function generateDateReportPdf(data, period, lineFilter = '') {
    const rows = buildProductionReportRows(data);
    const totals = rows.reduce((sum, row) => ({
      target: sum.target + row.target, output: sum.output + row.output,
      qc: sum.qc + row.qcChecked, defect: sum.defect + row.defect
    }), { target: 0, output: 0, qc: 0, defect: 0 });
    return createPdfReport({
      branding: readBrandingSettings(),
      title: 'LAPORAN PRODUKSI & QUALITY CONTROL',
      subtitle: 'Industrial performance report - fixed document format',
      meta: [['Periode', period], ['Line', lineFilter || 'Semua Line'], ['Dicetak', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })]],
      summary: [['Target', totals.target.toLocaleString('id-ID')], ['Output', totals.output.toLocaleString('id-ID')], ['Pencapaian', totals.target ? `${((totals.output / totals.target) * 100).toFixed(1)}%` : '0%'], ['QC Checked', totals.qc.toLocaleString('id-ID')], ['Defect', `${totals.defect.toLocaleString('id-ID')} (${totals.qc ? ((totals.defect / totals.qc) * 100).toFixed(2) : '0.00'}%)`]],
      columns: [
        { key: 'date', label: 'Tanggal', width: 58 }, { key: 'line', label: 'Line', width: 50 }, { key: 'labelWeek', label: 'Week', width: 45 },
        { key: 'model', label: 'Model', width: 105 }, { key: 'target', label: 'Target', width: 48 }, { key: 'output', label: 'Output', width: 48 },
        { key: 'achievementText', label: 'Ach.', width: 43 }, { key: 'qcChecked', label: 'QC', width: 42 }, { key: 'good', label: 'Good', width: 42 },
        { key: 'defect', label: 'Defect', width: 44 }, { key: 'defectRateText', label: 'Rate', width: 43 }, { key: 'severity', label: 'C/M/Mi', width: 58 },
        { key: 'defectTypes', label: 'Top Defect', width: 125 }
      ],
      rows: rows.map(row => ({ ...row, achievementText: `${row.achievement}%`, defectRateText: `${row.defectRate}%`, severity: `${row.criticalDefect}/${row.majorDefect}/${row.minorDefect}`, defectTypes: String(row.defectTypes || '-') }))
    });
  }

  function generateLineDetailPdf(modelData, lineName, modelId) {
    const qcDefectsByHour = {};
    (modelData.qcChecks || []).filter(check => check.result === 'defect').forEach(check => {
      const hourIndex = Number.isInteger(parseNonNegativeInteger(check.hourIndex)) ? parseNonNegativeInteger(check.hourIndex) : -1;
      const key = `${check.type || 'Tanpa jenis'} - ${check.area || 'Tanpa area'}`;
      qcDefectsByHour[hourIndex] = qcDefectsByHour[hourIndex] || {};
      qcDefectsByHour[hourIndex][key] = (qcDefectsByHour[hourIndex][key] || 0) + qcCheckQuantity(check);
    });
    const hourlyRows = (modelData.hourly_data || []).map((hour, hourIndex) => {
      const importedDetails = (hour.defectDetails || []).map(detail => ({
        label: `${detail.type || 'Tanpa jenis'} - ${detail.area || 'Tanpa area'}`,
        count: parseInt(detail.quantity) || 1
      }));
      const checkedDetails = Object.entries(qcDefectsByHour[hourIndex] || {}).map(([label, count]) => ({ label, count }));
      const detailCounts = [...importedDetails, ...checkedDetails].reduce((counts, detail) => {
        counts[detail.label] = (counts[detail.label] || 0) + detail.count;
        return counts;
      }, {});
      return {
      hour: hour.hour || '-', target: hour.targetManual || 0, output: hour.output || 0,
      variance: (hour.output || 0) - (hour.targetManual || 0), defect: hour.defect || 0,
      qc: hour.qcChecked || 0, good: Math.max((hour.qcChecked || 0) - (hour.defect || 0), 0),
      rate: `${hour.qcChecked ? (((hour.defect || 0) / hour.qcChecked) * 100).toFixed(2) : '0.00'}%`,
      defectInfo: Object.entries(detailCounts).map(([label, count]) => `${label} (${count})`).join('; ') || '-'
      };
    });
    return createPdfReport({
      branding: readBrandingSettings(),
      title: 'DETAIL PRODUKSI & QUALITY CONTROL', subtitle: 'Hourly traceability and quality performance',
      meta: [['Tanggal', modelData.date || '-'], ['Line', lineName], ['Model', modelData.model || modelId], ['Week', modelData.labelWeek || '-']],
      summary: [['Target', modelData.target || 0], ['Output', modelData.outputDay || 0], ['QC Checked', modelData.qcChecking || 0], ['Defect', modelData.actualDefect || 0], ['Defect Rate', `${modelData.defectRatePercentage || 0}%`]],
      columns: [{ key: 'hour', label: 'Jam', width: 60 }, { key: 'target', label: 'Target', width: 55 }, { key: 'output', label: 'Output', width: 55 }, { key: 'variance', label: 'Selisih', width: 55 }, { key: 'qc', label: 'QC', width: 55 }, { key: 'good', label: 'Good', width: 55 }, { key: 'defect', label: 'Defect', width: 55 }, { key: 'rate', label: 'Rate', width: 55 }, { key: 'defectInfo', label: 'Keterangan Defect', width: 250 }],
      rows: hourlyRows
    });
  }

  function getQcCheckHourLabel(model = {}, check = {}) {
    const index = parseNonNegativeInteger(check.hourIndex);
    if (Number.isInteger(index) && model.hourly_data && model.hourly_data[index]) {
      return model.hourly_data[index].hour || check.hour || '-';
    }

    if (check.hour) return check.hour;

    if (check.checkedAt) {
      const checkedDate = new Date(check.checkedAt);
      if (!Number.isNaN(checkedDate.getTime())) {
        return checkedDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      }
    }

    return '-';
  }

  function createProductionSummary(date, lineName = '') {
    return {
      date,
      lineName,
      lineCount: 0,
      modelCount: 0,
      target: 0,
      output: 0,
      defect: 0,
      criticalDefect: 0,
      majorDefect: 0,
      minorDefect: 0,
      qcChecked: 0,
      defectRate: 0,
      areaCounts: {},
      typeCounts: {}
    };
  }

  function addModelToProductionSummary(summary, model, defectConfig = readDefectConfig()) {
    summary.modelCount += 1;
    summary.target += parseInt(model.target) || 0;
    summary.output += parseInt(model.outputDay) || 0;
    summary.defect += parseInt(model.actualDefect) || 0;
    summary.qcChecked += parseInt(model.qcChecking) || 0;

    const defectBreakdown = calculateDefectSeverityBreakdown(model, defectConfig);
    summary.criticalDefect += defectBreakdown.critical.count;
    summary.majorDefect += defectBreakdown.major.count;
    summary.minorDefect += defectBreakdown.minor.count;

    (model.hourly_data || []).forEach(hour => {
      (hour.defectDetails || []).forEach(detail => {
        const quantity = parseInt(detail.quantity) || 1;
        addToCounter(summary.typeCounts, detail.type, quantity);
        addToCounter(summary.areaCounts, detail.area, quantity);
      });
    });

    (model.qcChecks || [])
      .filter(check => check.result === 'defect')
      .forEach(check => {
        addToCounter(summary.typeCounts, check.type, qcCheckQuantity(check));
        addToCounter(summary.areaCounts, check.area, qcCheckQuantity(check));
      });
  }

  function finalizeProductionSummary(summary) {
    summary.defectRate = summary.qcChecked > 0
      ? parseFloat(((summary.defect / summary.qcChecked) * 100).toFixed(2))
      : 0;
    return summary;
  }

  function summarizeProductionSnapshot(data, date, defectConfig = readDefectConfig()) {
    const summary = {
      date,
      lineCount: 0,
      modelCount: 0,
      target: 0,
      output: 0,
      defect: 0,
      criticalDefect: 0,
      majorDefect: 0,
      minorDefect: 0,
      qcChecked: 0,
      defectRate: 0,
      areaCounts: {},
      typeCounts: {}
    };

    Object.keys(data.lines || {}).forEach(lineName => {
      const line = ensureLineActiveModels(data.lines[lineName]);
      let hasModelForDate = false;

      (line.activeModels || []).forEach(modelId => {
        const model = line.models[modelId];
        if (!model) return;
        if (model.date && model.date !== date) return;

        hasModelForDate = true;
        summary.modelCount += 1;
        summary.target += parseInt(model.target) || 0;
        summary.output += parseInt(model.outputDay) || 0;
        summary.defect += parseInt(model.actualDefect) || 0;
        summary.qcChecked += parseInt(model.qcChecking) || 0;

        const defectBreakdown = calculateDefectSeverityBreakdown(model, defectConfig);
        summary.criticalDefect += defectBreakdown.critical.count;
        summary.majorDefect += defectBreakdown.major.count;
        summary.minorDefect += defectBreakdown.minor.count;

        (model.hourly_data || []).forEach(hour => {
          (hour.defectDetails || []).forEach(detail => {
            const quantity = parseInt(detail.quantity) || 1;
            addToCounter(summary.typeCounts, detail.type, quantity);
            addToCounter(summary.areaCounts, detail.area, quantity);
          });
        });

        (model.qcChecks || [])
          .filter(check => check.result === 'defect')
          .forEach(check => {
            addToCounter(summary.typeCounts, check.type, qcCheckQuantity(check));
            addToCounter(summary.areaCounts, check.area, qcCheckQuantity(check));
          });
      });

      if (hasModelForDate) summary.lineCount += 1;
    });

    summary.defectRate = summary.qcChecked > 0
      ? parseFloat(((summary.defect / summary.qcChecked) * 100).toFixed(2))
      : 0;

    return summary;
  }

  function summarizeProductionSnapshotByLine(data, date, defectConfig = readDefectConfig()) {
    const summaries = [];

    Object.keys(data.lines || {}).forEach(lineName => {
      const line = data.lines[lineName];
      const normalizedLine = ensureLineActiveModels(line);
      const activeModelIds = normalizedLine.activeModels || [];

      activeModelIds.forEach(activeModelId => {
        const activeModel = normalizedLine.models?.[activeModelId];
        if (!activeModel || (activeModel.date && activeModel.date !== date)) return;

        const summary = createProductionSummary(date, lineName);
        addModelToProductionSummary(summary, activeModel, defectConfig);
        if (summary.modelCount > 0) {
          summary.lineCount = 1;
          summary.modelId = activeModelId;
          summary.labelWeek = activeModel.labelWeek || '';
          summary.model = activeModel.model || '';
          summaries.push(finalizeProductionSummary(summary));
        }
      });
    });

    return summaries;
  }

  function topCounterItems(counter, limit = 5) {
    return Object.entries(counter)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  async function generateStyledDateReportExcel(data, date) {
    const workbook = new ExcelJS.Workbook();
    
    workbook.creator = 'Production Dashboard System';
    workbook.lastModifiedBy = 'Production Dashboard System';
    workbook.created = new Date();
    workbook.modified = new Date();
    
    const headerStyle = {
      font: { bold: true, color: { argb: 'FFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '4472C4' } },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: {
        top: { style: 'thin', color: { argb: '000000' } },
        left: { style: 'thin', color: { argb: '000000' } },
        bottom: { style: 'thin', color: { argb: '000000' } },
        right: { style: 'thin', color: { argb: '000000' } }
      }
    };
    
    const titleStyle = {
      font: { bold: true, size: 16, color: { argb: '1F4E78' } },
      alignment: { horizontal: 'center', vertical: 'middle' }
    };
    
    const dataStyle = {
      font: { size: 11 },
      border: {
        top: { style: 'thin', color: { argb: 'D9D9D9' } },
        left: { style: 'thin', color: { argb: 'D9D9D9' } },
        bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
        right: { style: 'thin', color: { argb: 'D9D9D9' } }
      }
    };
    
    const totalStyle = {
      font: { bold: true, color: { argb: 'FFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } },
      border: {
        top: { style: 'thin', color: { argb: '000000' } },
        left: { style: 'thin', color: { argb: '000000' } },
        bottom: { style: 'thin', color: { argb: '000000' } },
        right: { style: 'thin', color: { argb: '000000' } }
      }
    };
    
    const highlightStyle = {
      font: { bold: true, color: { argb: 'FFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC000' } },
      border: {
        top: { style: 'thin', color: { argb: '000000' } },
        left: { style: 'thin', color: { argb: '000000' } },
        bottom: { style: 'thin', color: { argb: '000000' } },
        right: { style: 'thin', color: { argb: '000000' } }
      }
    };

    const summarySheet = workbook.addWorksheet('SUMMARY');
    
  	  summarySheet.mergeCells('A1:Q1');
    const titleCell = summarySheet.getCell('A1');
  	  titleCell.value = 'LAPORAN PRODUKSI DAN QC - ' + date;
    titleCell.style = titleStyle;
    
  	  summarySheet.getCell('A3').value = 'Tanggal Export';
    summarySheet.getCell('B3').value = new Date().toLocaleString('id-ID');
  	  summarySheet.getCell('A4').value = 'Tanggal Laporan';
    summarySheet.getCell('B4').value = date;
  	  summarySheet.getCell('A5').value = 'Total Line';
    summarySheet.getCell('B5').value = Object.keys(data.lines).length;
    
  	  const headers = ['Tanggal', 'Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement', 'QC Checked', 'Good', 'Total Defect', 'Critical', 'Major', 'Minor', 'Defect Rate', 'Defect Area', 'Jenis Defect'];
    summarySheet.getRow(7).values = headers;
    summarySheet.getRow(7).eachCell((cell) => {
      cell.style = headerStyle;
    });
    
    let rowIndex = 8;
    let totalTarget = 0;
    let totalOutput = 0;
    let totalDefect = 0;
    let totalQCChecked = 0;
    let totalGood = 0;
    
    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
  	    Object.keys(line.models).forEach(modelId => {
  	      const model = line.models[modelId];
  	      const displayModelId = model.reportModelId || modelId;
  	      const achievement = model.target > 0 ? ((model.outputDay || 0) / model.target * 100).toFixed(2) + '%' : '0%';
  	      const defectCategories = summarizeModelDefectCategories(model);
  	      const defectBreakdown = calculateDefectSeverityBreakdown(model);
  	      
  	      const row = summarySheet.getRow(rowIndex);
  	      row.values = [
          model.date || date,
          lineName,
  	        displayModelId,
          model.labelWeek || '',
          model.model || '',
          model.target || 0,
  	        model.outputDay || 0,
  	        achievement,
  	        model.qcChecking || 0,
  	        Math.max((model.qcChecking || 0) - (model.actualDefect || 0), 0),
  	        model.actualDefect || 0,
  	        defectBreakdown.critical.count,
  	        defectBreakdown.major.count,
  	        defectBreakdown.minor.count,
  	        (model.defectRatePercentage || 0) + '%',
  	        defectCategories.areas,
  	        defectCategories.types
  	      ];
        
        const achievementCell = row.getCell(8);
        const achievementValue = parseFloat(achievement);
        if (achievementValue >= 100) {
          achievementCell.font = { color: { argb: '00B050' }, bold: true };
        } else if (achievementValue >= 80) {
          achievementCell.font = { color: { argb: 'FFC000' }, bold: true };
        } else {
          achievementCell.font = { color: { argb: 'FF0000' }, bold: true };
        }
        
  	      const defectRateCell = row.getCell(15);
        const defectRateValue = model.defectRatePercentage || 0;
        if (defectRateValue <= 5) {
          defectRateCell.font = { color: { argb: '00B050' }, bold: true };
        } else if (defectRateValue <= 10) {
          defectRateCell.font = { color: { argb: 'FFC000' }, bold: true };
        } else {
          defectRateCell.font = { color: { argb: 'FF0000' }, bold: true };
        }
        
        row.eachCell((cell) => {
          cell.style = dataStyle;
        });
        
        totalTarget += model.target || 0;
        totalOutput += model.outputDay || 0;
        totalDefect += model.actualDefect || 0;
        totalQCChecked += model.qcChecking || 0;
        totalGood += Math.max((model.qcChecking || 0) - (model.actualDefect || 0), 0);
        
        rowIndex++;
      });
    });
    
    const totalAchievement = totalTarget > 0 ? ((totalOutput / totalTarget) * 100).toFixed(2) + '%' : '0%';
    const totalDefectRate = totalQCChecked > 0 ? ((totalDefect / totalQCChecked) * 100).toFixed(2) + '%' : '0%';
    
    const totalRow = summarySheet.getRow(rowIndex);
    totalRow.values = [
      'TOTAL',
      '',
      '',
      '',
      '',
      totalTarget,
  	    totalOutput,
  	    totalAchievement,
  	    totalQCChecked,
  	    totalGood,
  	    totalDefect,
  	    '',
  	    '',
  	    '',
  	    totalDefectRate,
  	    '',
  	    ''
  	  ];
    totalRow.eachCell((cell) => {
      cell.style = totalStyle;
    });
    
    summarySheet.columns = [
  	    { width: 14 },
  	    { width: 15 },
  	    { width: 12 },
  	    { width: 15 },
  	    { width: 30 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 15 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 15 },
  	    { width: 32 },
  	    { width: 32 }
  	  ];

    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      const lineSheet = workbook.addWorksheet(lineName.substring(0, 31));
      
      let currentRow = 1;
      
  	    lineSheet.mergeCells(`A${currentRow}:H${currentRow}`);
      const lineTitle = lineSheet.getCell(`A${currentRow}`);
  	    lineTitle.value = `DETAIL LAPORAN PRODUKSI DAN QC - ${lineName} - ${date}`;
      lineTitle.style = titleStyle;
      currentRow += 2;

      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        const displayModelId = model.reportModelId || modelId;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Model ID';
        lineSheet.getCell(`B${currentRow}`).value = displayModelId;
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Label/Week';
        lineSheet.getCell(`B${currentRow}`).value = model.labelWeek || '';
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Model';
        lineSheet.getCell(`B${currentRow}`).value = model.model || '';
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Date';
        lineSheet.getCell(`B${currentRow}`).value = model.date || '';
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Target';
        lineSheet.getCell(`B${currentRow}`).value = model.target || 0;
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Output';
        lineSheet.getCell(`B${currentRow}`).value = model.outputDay || 0;
        currentRow++;

        lineSheet.getCell(`A${currentRow}`).value = 'QC Checked';
        lineSheet.getCell(`B${currentRow}`).value = model.qcChecking || 0;
        currentRow++;

        lineSheet.getCell(`A${currentRow}`).value = 'Good';
        lineSheet.getCell(`B${currentRow}`).value = Math.max((model.qcChecking || 0) - (model.actualDefect || 0), 0);
        currentRow++;

        lineSheet.getCell(`A${currentRow}`).value = 'Total Defect';
        lineSheet.getCell(`B${currentRow}`).value = model.actualDefect || 0;
        currentRow++;
        
        lineSheet.getCell(`A${currentRow}`).value = 'Defect Rate';
        lineSheet.getCell(`B${currentRow}`).value = (model.defectRatePercentage || 0) + '%';
        currentRow += 2;
        
  	      const hourlyHeaders = ['Jam', 'Target Manual', 'Output', 'Selisih', 'Total Defect', 'QC Checked', 'Good', 'Defect Rate'];
        lineSheet.getRow(currentRow).values = hourlyHeaders;
        lineSheet.getRow(currentRow).eachCell((cell) => {
          cell.style = headerStyle;
        });
        currentRow++;
        
  	      if (model.hourly_data && model.hourly_data.length > 0) {
  	        model.hourly_data.forEach(hour => {
  	          const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
  	          const selisih = (hour.output || 0) - (hour.targetManual || 0);
  	          const row = lineSheet.getRow(currentRow);
  	          row.values = [
  	            hour.hour,
  	            hour.targetManual || 0,
  	            hour.output || 0,
  	            selisih,
  	            hour.defect || 0,
  	            hour.qcChecked || 0,
  	            Math.max((hour.qcChecked || 0) - (hour.defect || 0), 0),
  	            defectRate + '%'
  	          ];
            
            const selisihCell = row.getCell(4);
            if (selisih >= 0) {
              selisihCell.font = { color: { argb: '00B050' }, bold: true };
            } else {
              selisihCell.font = { color: { argb: 'FF0000' }, bold: true };
            }
            
  	          const defectRateCell = row.getCell(8);
            const defectRateValue = parseFloat(defectRate);
            if (defectRateValue <= 5) {
              defectRateCell.font = { color: { argb: '00B050' }, bold: true };
            } else if (defectRateValue <= 10) {
              defectRateCell.font = { color: { argb: 'FFC000' }, bold: true };
            } else {
              defectRateCell.font = { color: { argb: 'FF0000' }, bold: true };
            }
            
            row.eachCell((cell) => {
              cell.style = dataStyle;
            });
            
            currentRow++;
          });
        }
        
  	      currentRow += 2;

  	      const defectDetailHeaders = ['Jam', 'Jenis Defect', 'Kategori', 'Defect Area', 'Qty', 'Notes'];
  	      lineSheet.getRow(currentRow).values = defectDetailHeaders;
  	      lineSheet.getRow(currentRow).eachCell((cell) => {
  	        cell.style = headerStyle;
  	      });
  	      currentRow++;

  	      let hasDefectDetail = false;
  	      (model.hourly_data || []).forEach(hour => {
  	        (hour.defectDetails || []).forEach(detail => {
  	          hasDefectDetail = true;
  	          const row = lineSheet.getRow(currentRow);
  	          row.values = [
  	            hour.hour,
  	            detail.type || '-',
  	            getDefectSeverityLabel(detail.type),
  	            detail.area || '-',
  	            parseInt(detail.quantity) || 0,
  	            detail.notes || ''
  	          ];
  	          row.eachCell((cell) => {
  	            cell.style = dataStyle;
  	          });
  	          currentRow++;
  	        });
  	      });

  	      (model.qcChecks || [])
  	        .filter(check => check.result === 'defect')
  	        .forEach(check => {
  	          hasDefectDetail = true;
  	          const row = lineSheet.getRow(currentRow);
          row.values = [
            getQcCheckHourLabel(model, check),
            check.type || '-',
            getDefectSeverityLabel(check.type),
            check.area || '-',
            qcCheckQuantity(check),
            check.notes || ''
          ];
  	          row.eachCell((cell) => {
  	            cell.style = dataStyle;
  	          });
  	          currentRow++;
  	        });

  	      if (!hasDefectDetail) {
  	        const row = lineSheet.getRow(currentRow);
  	        row.values = ['-', '-', '-', '-', 0, 'Tidak ada detail defect'];
  	        row.eachCell((cell) => {
  	          cell.style = dataStyle;
  	        });
  	        currentRow++;
  	      }

  	      currentRow += 3;
  	    });
      
  	    lineSheet.columns = [
  	      { width: 15 },
  	      { width: 32 },
  	      { width: 32 },
  	      { width: 12 },
  	      { width: 32 },
  	      { width: 15 },
  	      { width: 12 },
  	      { width: 18 }
  	    ];
    });

    const performanceSheet = workbook.addWorksheet('PERFORMANCE');
    
    performanceSheet.mergeCells('A1:E1');
    const performanceTitle = performanceSheet.getCell('A1');
  	  performanceTitle.value = 'RINGKASAN PERFORMA - ' + date;
    performanceTitle.style = titleStyle;
    
  	  const performanceHeaders = ['Line', 'Total Target', 'Total Output', 'Achievement', 'Status'];
    performanceSheet.getRow(3).values = performanceHeaders;
    performanceSheet.getRow(3).eachCell((cell) => {
      cell.style = headerStyle;
    });
    
    let perfRowIndex = 4;
    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      let lineTarget = 0;
      let lineOutput = 0;
      
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        lineTarget += model.target || 0;
        lineOutput += model.outputDay || 0;
      });
      
      const achievement = lineTarget > 0 ? ((lineOutput / lineTarget) * 100).toFixed(2) + '%' : '0%';
  	    const status = lineOutput >= lineTarget ? 'SESUAI TARGET' : 'DI BAWAH TARGET';
      
      const row = performanceSheet.getRow(perfRowIndex);
      row.values = [
        lineName,
        lineTarget,
        lineOutput,
        achievement,
        status
      ];
      
      const achievementCell = row.getCell(4);
      const achievementValue = parseFloat(achievement);
      if (achievementValue >= 100) {
        achievementCell.font = { color: { argb: '00B050' }, bold: true };
      } else if (achievementValue >= 80) {
        achievementCell.font = { color: { argb: 'FFC000' }, bold: true };
      } else {
        achievementCell.font = { color: { argb: 'FF0000' }, bold: true };
      }
      
      const statusCell = row.getCell(5);
  	    if (status === 'SESUAI TARGET') {
        statusCell.font = { color: { argb: '00B050' }, bold: true };
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'C6EFCE' } };
      } else {
        statusCell.font = { color: { argb: 'FF0000' }, bold: true };
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC7CE' } };
      }
      
      row.eachCell((cell) => {
        if (cell.value !== status) {
          cell.style = dataStyle;
        }
      });
      
      perfRowIndex++;
    });
    
    const totalAchievementPerf = totalTarget > 0 ? ((totalOutput / totalTarget) * 100).toFixed(2) + '%' : '0%';
  	  const overallStatus = totalOutput >= totalTarget ? 'SESUAI TARGET' : 'DI BAWAH TARGET';
    
    const totalPerfRow = performanceSheet.getRow(perfRowIndex);
    totalPerfRow.values = [
      'TOTAL',
      totalTarget,
      totalOutput,
      totalAchievementPerf,
      overallStatus
    ];
    totalPerfRow.eachCell((cell) => {
      cell.style = totalStyle;
    });
    
    performanceSheet.columns = [
      { width: 15 },
      { width: 15 },
      { width: 15 },
      { width: 15 },
      { width: 20 }
    ];
    
    return workbook;
  }

  async function generateScopedDateReportExcel(data, date, role) {
    const isSewing = role === 'admin_operator_sewing';
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(isSewing ? 'SUMMARY SEWING' : 'SUMMARY QC');
    const headers = isSewing
      ? ['Line', 'Model ID', 'Label/Week', 'Model', 'Target', 'Output', 'Achievement %']
      : ['Line', 'Model ID', 'Label/Week', 'Model', 'QC Checked', 'Defect', 'Critical', 'Major', 'Minor', 'Jenis Defect', 'Area Defect', 'Defect Rate %'];

    sheet.mergeCells(1, 1, 1, headers.length);
    const title = sheet.getCell(1, 1);
    title.value = `${isSewing ? 'SUMMARY HASIL SEWING' : 'SUMMARY HASIL QC'} - ${date}`;
    title.font = { bold: true, size: 16, color: { argb: '1F4E78' } };
    title.alignment = { horizontal: 'center' };

    sheet.getRow(3).values = headers;
    sheet.getRow(3).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isSewing ? '4472C4' : '00A6A6' } };
      cell.alignment = { horizontal: 'center' };
    });

    let rowIndex = 4;
    Object.entries(data.lines || {}).forEach(([lineName, line]) => {
      Object.entries(line.models || {}).forEach(([modelId, model]) => {
        if (model.date && model.date !== date) return;

        const achievement = model.target > 0 ? (((model.outputDay || 0) / model.target) * 100).toFixed(2) : '0.00';
        const defectCategories = summarizeModelDefectCategories(model);
        const defectBreakdown = calculateDefectSeverityBreakdown(model);
        const values = isSewing
          ? [lineName, modelId, model.labelWeek || '', model.model || '', model.target || 0, model.outputDay || 0, `${achievement}%`]
          : [lineName, modelId, model.labelWeek || '', model.model || '', model.qcChecking || 0, model.actualDefect || 0, defectBreakdown.critical.count, defectBreakdown.major.count, defectBreakdown.minor.count, defectCategories.types, defectCategories.areas, `${model.defectRatePercentage || 0}%`];

        const row = sheet.getRow(rowIndex++);
        row.values = values;
        row.eachCell(cell => {
          cell.border = {
            top: { style: 'thin', color: { argb: 'D9D9D9' } },
            left: { style: 'thin', color: { argb: 'D9D9D9' } },
            bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
            right: { style: 'thin', color: { argb: 'D9D9D9' } }
          };
        });
      });
    });

    sheet.columns = headers.map(header => ({ width: ['Model', 'Jenis Defect', 'Area Defect'].includes(header) ? 28 : 16 }));
    sheet.views = [{ state: 'frozen', ySplit: 3 }];
    sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: headers.length } };
    return workbook;
  }

  async function generateScopedLineReportExcel(modelData, lineName, modelId, role) {
    const isSewing = role === 'admin_operator_sewing' || role === 'admin_operator';
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Production Dashboard System';

    const summary = workbook.addWorksheet(isSewing ? 'SUMMARY SEWING' : 'SUMMARY QC');
    const title = isSewing ? 'DETAIL HASIL SEWING' : 'DETAIL HASIL QC';
    const headerColor = isSewing ? '4472C4' : '00A6A6';
    const defectBreakdown = calculateDefectSeverityBreakdown(modelData);
    const summaryRows = isSewing
      ? [
          ['Line', lineName],
          ['Model ID', modelId],
          ['Label/Week', modelData.labelWeek || ''],
          ['Model', modelData.model || ''],
          ['Tanggal', modelData.date || ''],
          ['Target', modelData.target || 0],
          ['Output', modelData.outputDay || 0],
          ['Achievement', `${modelData.target > 0 ? (((modelData.outputDay || 0) / modelData.target) * 100).toFixed(2) : '0.00'}%`]
        ]
      : [
          ['Line', lineName],
          ['Model ID', modelId],
          ['Label/Week', modelData.labelWeek || ''],
          ['Model', modelData.model || ''],
          ['Tanggal', modelData.date || ''],
          ['QC Checked', modelData.qcChecking || 0],
          ['Good', Math.max(0, (modelData.qcChecking || 0) - (modelData.actualDefect || 0))],
          ['Defect', modelData.actualDefect || 0],
          ['Critical Defect', defectBreakdown.critical.count],
          ['Major Defect', defectBreakdown.major.count],
          ['Minor Defect', defectBreakdown.minor.count],
          ['Defect Rate', `${modelData.defectRatePercentage || 0}%`]
        ];

    summary.mergeCells('A1:B1');
    summary.getCell('A1').value = `${title} - ${lineName}`;
    summary.getCell('A1').font = { bold: true, size: 16, color: { argb: '1F4E78' } };
    summary.getCell('A1').alignment = { horizontal: 'center' };
    summaryRows.forEach((values, index) => {
      const row = summary.getRow(index + 3);
      row.values = values;
      row.getCell(1).font = { bold: true };
    });
    summary.columns = [{ width: 22 }, { width: 32 }];

    const detail = workbook.addWorksheet(isSewing ? 'DETAIL PER JAM' : 'DETAIL PEMERIKSAAN');
    const headers = isSewing
      ? ['Jam', 'Target Manual', 'Output', 'Selisih', 'Achievement %']
      : ['No', 'Jam', 'Hasil', 'Qty', 'Jenis Defect', 'Kategori', 'Area Defect', 'Catatan', 'Waktu Pemeriksaan'];
    detail.getRow(1).values = headers;
    detail.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerColor } };
      cell.alignment = { horizontal: 'center' };
    });

    if (isSewing) {
      (modelData.hourly_data || []).forEach((hour, index) => {
        const target = hour.targetManual || 0;
        const output = hour.output || 0;
        detail.addRow([hour.hour || '', target, output, output - target, `${target > 0 ? ((output / target) * 100).toFixed(2) : '0.00'}%`]);
      });
    } else {
      const qcChecks = modelData.qcChecks || [];
      if (qcChecks.length > 0) {
        qcChecks.forEach((check, index) => {
          detail.addRow([
            index + 1,
            check.hour || '',
            check.result === 'defect' ? 'Defect' : 'Good',
            qcCheckQuantity(check),
            check.type || '',
            check.result === 'defect' ? getDefectSeverityLabel(check.type) : '',
            check.area || '',
            check.notes || '',
            check.checkedAt ? new Date(check.checkedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : ''
          ]);
        });
      } else {
        // Arsip lama menyimpan rekap QC per jam sebelum pencatatan per pemeriksaan tersedia.
        (modelData.hourly_data || []).filter(hour => (hour.qcChecked || 0) > 0).forEach((hour, index) => {
          const categories = summarizeDefectCategoriesFromDetails(hour.defectDetails || []);
          detail.addRow([
            index + 1,
            hour.hour || '',
            `Rekap: ${hour.qcChecked || 0} checked / ${hour.defect || 0} defect`,
            hour.qcChecked || 0,
            categories.types,
            '-',
            categories.areas,
            '',
            ''
          ]);
        });
      }
    }

    detail.columns = headers.map((header, index) => ({ width: index >= 3 ? 24 : 16 }));
    detail.views = [{ state: 'frozen', ySplit: 1 }];
    detail.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    return workbook;
  }

  async function generateStyledExcelData(modelData, lineName, modelId) {
    const workbook = new ExcelJS.Workbook();
    
    workbook.creator = 'Production Dashboard System';
    workbook.lastModifiedBy = 'Production Dashboard System';
    workbook.created = new Date();
    workbook.modified = new Date();
    
    const headerStyle = {
      font: { bold: true, color: { argb: 'FFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '4472C4' } },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: {
        top: { style: 'thin', color: { argb: '000000' } },
        left: { style: 'thin', color: { argb: '000000' } },
        bottom: { style: 'thin', color: { argb: '000000' } },
        right: { style: 'thin', color: { argb: '000000' } }
      }
    };
    
    const titleStyle = {
      font: { bold: true, size: 16, color: { argb: '1F4E78' } },
      alignment: { horizontal: 'center', vertical: 'middle' }
    };
    
    const dataStyle = {
      font: { size: 11 },
      border: {
        top: { style: 'thin', color: { argb: 'D9D9D9' } },
        left: { style: 'thin', color: { argb: 'D9D9D9' } },
        bottom: { style: 'thin', color: { argb: 'D9D9D9' } },
        right: { style: 'thin', color: { argb: 'D9D9D9' } }
      }
    };
    
    const totalStyle = {
      font: { bold: true, color: { argb: 'FFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: '70AD47' } },
      border: {
        top: { style: 'thin', color: { argb: '000000' } },
        left: { style: 'thin', color: { argb: '000000' } },
        bottom: { style: 'thin', color: { argb: '000000' } },
        right: { style: 'thin', color: { argb: '000000' } }
      }
    };
    
    const summarySheet = workbook.addWorksheet('SUMMARY');
    
  	  summarySheet.mergeCells('A1:M1');
    const titleCell = summarySheet.getCell('A1');
  	  titleCell.value = 'DETAIL LAPORAN PRODUKSI DAN QC';
    titleCell.style = titleStyle;
    
    summarySheet.getCell('A3').value = 'Line';
    summarySheet.getCell('B3').value = lineName;
    summarySheet.getCell('A4').value = 'Model ID';
    summarySheet.getCell('B4').value = modelId;
    summarySheet.getCell('A5').value = 'Label/Week';
    summarySheet.getCell('B5').value = modelData.labelWeek || '';
    summarySheet.getCell('A6').value = 'Model';
    summarySheet.getCell('B6').value = modelData.model || '';
  	  summarySheet.getCell('A7').value = 'Tanggal';
    summarySheet.getCell('B7').value = modelData.date || '';
    
  	  const headers = ['Metrik', 'Nilai', 'Target per Hour', 'Output/Hari', 'QC Checked', 'Good', 'Total Defect', 'Critical', 'Major', 'Minor', 'Defect Area', 'Jenis Defect', 'Defect Rate'];
  	  summarySheet.getRow(9).values = headers;
    summarySheet.getRow(9).eachCell((cell) => {
      cell.style = headerStyle;
    });
    
  	  const modelDefectCategories = summarizeModelDefectCategories(modelData);
  	  const modelDefectBreakdown = calculateDefectSeverityBreakdown(modelData);
  	  
  	  const dataRow1 = summarySheet.getRow(10);
  	  dataRow1.values = [
  	    'Data Produksi',
      modelData.target || 0,
      modelData.targetPerHour || 0,
  	    modelData.outputDay || 0,
  	    modelData.qcChecking || 0,
  	    Math.max((modelData.qcChecking || 0) - (modelData.actualDefect || 0), 0),
  	    modelData.actualDefect || 0,
  	    modelDefectBreakdown.critical.count,
  	    modelDefectBreakdown.major.count,
  	    modelDefectBreakdown.minor.count,
  	    modelDefectCategories.areas,
  	    modelDefectCategories.types,
  	    (modelData.defectRatePercentage || 0) + '%'
  	  ];
    dataRow1.eachCell((cell) => {
      cell.style = dataStyle;
    });
    
    const achievement = modelData.target > 0 ? ((modelData.outputDay || 0) / modelData.target * 100).toFixed(2) + '%' : '0%';
    
    const dataRow2 = summarySheet.getRow(11);
    dataRow2.values = [
  	    'Performa',
      achievement,
      '',
      '',
  	    '',
  	    '',
  	    '',
  	    '',
  	    '',
  	    '',
  	    '',
  	    '',
  	    ''
  	  ];
    dataRow2.eachCell((cell) => {
      cell.style = dataStyle;
    });
    
    summarySheet.columns = [
      { width: 20 },
      { width: 15 },
      { width: 15 },
      { width: 15 },
  	    { width: 15 },
  	    { width: 15 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 12 },
  	    { width: 32 },
  	    { width: 32 },
  	    { width: 15 }
  	  ];
    
    const hourlySheet = workbook.addWorksheet('HOURLY DATA');
    
  	  hourlySheet.mergeCells('A1:J1');
    const hourlyTitle = hourlySheet.getCell('A1');
    hourlyTitle.value = 'HOURLY PRODUCTION DATA';
    hourlyTitle.style = titleStyle;
    
  	  const hourlyHeaders = ['Jam', 'Target Manual', 'Output', 'Selisih (Output - Target)', 'Total Defect', 'Jenis Defect', 'Defect Area', 'QC Checked', 'Good', 'Defect Rate'];
    hourlySheet.getRow(3).values = hourlyHeaders;
    hourlySheet.getRow(3).eachCell((cell) => {
      cell.style = headerStyle;
    });
    
    let rowIndex = 4;
    let totalTargetManual = 0;
    let totalOutput = 0;
    let totalDefect = 0;
    let totalQCChecked = 0;
    
    if (modelData.hourly_data && modelData.hourly_data.length > 0) {
  	    modelData.hourly_data.forEach(hour => {
  	      const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
  	      const selisih = (hour.output || 0) - (hour.targetManual || 0);
  	      const defectCategories = summarizeDefectCategoriesFromDetails(hour.defectDetails || []);
  	      
  	      const row = hourlySheet.getRow(rowIndex);
        row.values = [
          hour.hour,
          hour.targetManual || 0,
          hour.output || 0,
  	        selisih,
  	        hour.defect || 0,
  	        defectCategories.types,
  	        defectCategories.areas,
  	        hour.qcChecked || 0,
  	        Math.max((hour.qcChecked || 0) - (hour.defect || 0), 0),
  	        defectRate + '%'
  	      ];
        
        const selisihCell = row.getCell(4);
        if (selisih >= 0) {
          selisihCell.font = { color: { argb: '00B050' }, bold: true };
        } else {
          selisihCell.font = { color: { argb: 'FF0000' }, bold: true };
        }
        
  	      const defectRateCell = row.getCell(10);
        const defectRateValue = parseFloat(defectRate);
        if (defectRateValue <= 5) {
          defectRateCell.font = { color: { argb: '00B050' }, bold: true };
        } else if (defectRateValue <= 10) {
          defectRateCell.font = { color: { argb: 'FFC000' }, bold: true };
        } else {
          defectRateCell.font = { color: { argb: 'FF0000' }, bold: true };
        }
        
        row.eachCell((cell) => {
          cell.style = dataStyle;
        });
        
        totalTargetManual += hour.targetManual || 0;
        totalOutput += hour.output || 0;
        totalDefect += hour.defect || 0;
        totalQCChecked += hour.qcChecked || 0;
        
        rowIndex++;
      });
    }
    
    const totalDefectRate = totalQCChecked > 0 ? ((totalDefect / totalQCChecked) * 100).toFixed(2) : '0.00';
    const totalSelisih = totalOutput - totalTargetManual;
    
    const totalRow = hourlySheet.getRow(rowIndex);
    totalRow.values = [
      'TOTAL',
      totalTargetManual,
      totalOutput,
  	    totalSelisih,
  	    totalDefect,
  	    '',
  	    '',
  	    totalQCChecked,
  	    Math.max(totalQCChecked - totalDefect, 0),
  	    totalDefectRate + '%'
  	  ];
    totalRow.eachCell((cell) => {
      cell.style = totalStyle;
    });
    
    hourlySheet.columns = [
      { width: 15 },
      { width: 15 },
      { width: 12 },
  	    { width: 20 },
  	    { width: 12 },
  	    { width: 32 },
  	    { width: 32 },
  	    { width: 15 },
  	    { width: 12 },
  	    { width: 15 }
  	  ];
    
    if (modelData.operators && modelData.operators.length > 0) {
      const operatorSheet = workbook.addWorksheet('OPERATOR DATA');
      
      operatorSheet.mergeCells('A1:H1');
      const operatorTitle = operatorSheet.getCell('A1');
      operatorTitle.value = 'OPERATOR PERFORMANCE';
      operatorTitle.style = titleStyle;
      
      const operatorHeaders = ['No', 'Nama Operator', 'Posisi', 'Target', 'Output', 'Defect', 'Efisiensi (%)', 'Status'];
      operatorSheet.getRow(3).values = operatorHeaders;
      operatorSheet.getRow(3).eachCell((cell) => {
        cell.style = headerStyle;
      });
      
      let opRowIndex = 4;
      modelData.operators.forEach((operator, index) => {
        const statusText = operator.status === 'active' ? 'Aktif' : 
                          operator.status === 'break' ? 'Istirahat' : 'Off';
        
        const row = operatorSheet.getRow(opRowIndex);
        row.values = [
          index + 1,
          operator.name,
          operator.position,
          operator.target,
          operator.output,
          operator.defect,
          operator.efficiency,
          statusText
        ];
        
        const statusCell = row.getCell(8);
        if (operator.status === 'active') {
          statusCell.font = { color: { argb: '00B050' }, bold: true };
        } else if (operator.status === 'break') {
          statusCell.font = { color: { argb: 'FFC000' }, bold: true };
        } else {
          statusCell.font = { color: { argb: 'FF0000' }, bold: true };
        }
        
        const efficiencyCell = row.getCell(7);
        if (operator.efficiency >= 100) {
          efficiencyCell.font = { color: { argb: '00B050' }, bold: true };
        } else if (operator.efficiency >= 80) {
          efficiencyCell.font = { color: { argb: 'FFC000' }, bold: true };
        } else {
          efficiencyCell.font = { color: { argb: 'FF0000' }, bold: true };
        }
        
        row.eachCell((cell) => {
          cell.style = dataStyle;
        });
        
        opRowIndex++;
      });
      
      operatorSheet.columns = [
        { width: 8 },
        { width: 25 },
        { width: 20 },
        { width: 12 },
        { width: 12 },
        { width: 12 },
        { width: 15 },
        { width: 12 }
      ];
    }
    
    return workbook;
  }

  return {
    addToCounter,
    buildDateRangeProductionData,
    buildDateReportRows,
    buildProductionReportRows,
    filterProductionDataByDate,
    filterProductionDataByLine,
    generateScopedDateReportExcel,
    generateScopedLineReportExcel,
    generateDateReportPdf,
    generateLineDetailPdf,
    generateStyledDateReportExcel,
    generateStyledExcelData,
    isValidDateRange,
    mergeProductionSnapshotsByDate,
    readProductionSnapshotForDate,
    summarizeProductionSnapshot,
    summarizeProductionSnapshotByLine,
    topCounterItems
  };
}

module.exports = { createReportService };
