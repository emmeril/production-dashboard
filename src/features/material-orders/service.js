const { createPdfReport } = require('../../shared/pdf');

function createMaterialOrderService(dependencies) {
  const {
    ExcelJS,
    getToday,
    isValidDateInput,
    normalizeLabelWeek,
    normalizeLabelWeekKey,
    normalizeProductionLineName,
    productionSnapshotCache,
    readProductionData,
    readProductionSnapshotForDate
  } = dependencies;

  const MATERIAL_ORDER_STATUSES = ['planned', 'in_production', 'completed'];

  function buildInitialMaterialOrders() {
    return { orders: [] };
  }

  function normalizeMaterialOrderProduction(production = {}) {
    return {
      lineName: normalizeProductionLineName(production.lineName),
      modelId: String(production.modelId || '').trim(),
      status: MATERIAL_ORDER_STATUSES.includes(production.status) ? production.status : 'planned',
      qtyResult: Math.max(0, parseInt(production.qtyResult) || 0)
    };
  }

  function getMaterialOrderProductions(order = {}) {
    const productions = Array.isArray(order.productions) && order.productions.length > 0
      ? order.productions
      : (order.lineName || order.modelId
        ? [{
            lineName: order.lineName,
            modelId: order.modelId,
            status: order.status,
            qtyResult: order.qtyResult
          }]
        : []);

    return productions
      .map(normalizeMaterialOrderProduction)
      .filter(production => production.lineName || production.modelId || production.qtyResult > 0);
  }

  function getProductionLine(productionData, lineName) {
    const normalizedLineName = normalizeProductionLineName(lineName);
    const matchingLineName = Object.keys(productionData?.lines || {}).find(candidate =>
      normalizeProductionLineName(candidate) === normalizedLineName
    );
    return productionData?.lines?.[matchingLineName] || null;
  }

  function deriveMaterialOrderStatus(productions = []) {
    if (productions.some(production => production.status === 'in_production')) return 'in_production';
    if (productions.length > 0 && productions.every(production => production.status === 'completed')) return 'completed';
    return 'planned';
  }

  function deriveMaterialOrderProgressStatus(qtyOrder, qtyResult, productions = []) {
    const orderQty = Math.max(0, Number(qtyOrder) || 0);
    const resultQty = Math.max(0, Number(qtyResult) || 0);
    if (orderQty > 0 && resultQty >= orderQty) return 'completed';
    if (resultQty > 0) return 'in_production';
    return 'planned';
  }

  function summarizeMaterialOrderProductionFields(productions = []) {
    const normalizedProductions = productions.map(normalizeMaterialOrderProduction);
    const uniqueLines = [...new Set(normalizedProductions.map(production => production.lineName).filter(Boolean))];
    const qtyResult = normalizedProductions.reduce((total, production) => total + (Number(production.qtyResult) || 0), 0);

    return {
      lineName: uniqueLines.join(', '),
      modelId: normalizedProductions.length === 1 ? normalizedProductions[0].modelId : '',
      status: deriveMaterialOrderStatus(normalizedProductions),
      qtyResult
    };
  }

  function normalizeMaterialOrderRecord(order = {}) {
    const productions = getMaterialOrderProductions(order);
    const productionSummary = summarizeMaterialOrderProductionFields(productions);

    return {
      id: parseInt(order.id) || 0,
      poMaterial: String(order.poMaterial || '').trim(),
      orderMaterial: String(order.orderMaterial || '').trim(),
      qtyOrder: Math.max(0, parseInt(order.qtyOrder) || 0),
      productions,
      lineName: productionSummary.lineName,
      modelId: productionSummary.modelId,
      status: productionSummary.status,
      qtyResult: productionSummary.qtyResult,
      orderDate: isValidDateInput(order.orderDate) ? order.orderDate : getToday(),
      notes: String(order.notes || '').trim(),
      createdBy: String(order.createdBy || '').trim(),
      createdAt: String(order.createdAt || ''),
      updatedAt: String(order.updatedAt || '')
    };
  }

  function normalizeMaterialOrders(data = {}) {
    return {
      orders: Array.isArray(data.orders)
        ? data.orders.map(normalizeMaterialOrderRecord).filter(order => order.id > 0)
        : []
    };
  }

  function getMaterialOrderActualQty(model, fallback = 0) {
    const value = model ? model.outputDay : fallback;
    return Math.max(0, parseInt(value) || 0);
  }

  function materialOrderProductionIdentity(lineName, model = {}) {
    const normalize = value => String(value || '').trim().toLowerCase();
    return `${normalize(lineName)}::${normalizeLabelWeekKey(model.labelWeek)}::${normalize(model.model)}`;
  }

  function normalizeMaterialOrderIdentity(identity) {
    const parts = String(identity || '').split('::');
    if (parts.length !== 3) return String(identity || '').trim().toLowerCase();
    return [
      String(parts[0] || '').trim().toLowerCase(),
      normalizeLabelWeekKey(parts[1]),
      String(parts[2] || '').trim().toLowerCase()
    ].join('::');
  }

  function preserveMaterialOrderProductionIdentity(lineName, model, nextLabelWeek, nextModelName) {
    if (!model) return;
    const currentIdentity = materialOrderProductionIdentity(lineName, model);
    const nextIdentity = materialOrderProductionIdentity(lineName, {
      labelWeek: nextLabelWeek,
      model: nextModelName
    });
    if (currentIdentity === nextIdentity) return;

    const aliases = Array.isArray(model.materialOrderIdentityAliases)
      ? model.materialOrderIdentityAliases.map(normalizeMaterialOrderIdentity).filter(Boolean)
      : [];
    model.materialOrderIdentityAliases = [...new Set([...aliases, currentIdentity])];
  }

  function getMaterialOrderHistoricalProductionData() {
    const today = getToday();
    const dates = new Set();
    productionSnapshotCache.forEach(snapshot => {
      if (snapshot.type === 'daily' && snapshot.snapshotDate !== today) dates.add(snapshot.snapshotDate);
    });

    return [...dates]
      .sort((a, b) => a.localeCompare(b))
      .map(date => readProductionSnapshotForDate(date))
      .filter(Boolean);
  }

  function buildMaterialOrderCumulativeOutputs(productionData = readProductionData(), historicalData = null) {
    const totals = {};
    const sources = [
      ...(Array.isArray(historicalData) ? historicalData : getMaterialOrderHistoricalProductionData()),
      productionData
    ];

    sources.forEach(data => {
      Object.entries(data?.lines || {}).forEach(([lineName, line]) => {
        Object.values(line.models || {}).forEach(model => {
          const identity = materialOrderProductionIdentity(lineName, model);
          totals[identity] = (totals[identity] || 0) + getMaterialOrderActualQty(model);
        });
      });
    });

    return totals;
  }

  function getMaterialOrderCumulativeOutput(lineName, model, cumulativeOutputs = {}) {
    if (!model) return 0;
    const identities = [...new Set([
      materialOrderProductionIdentity(lineName, model),
      ...(Array.isArray(model.materialOrderIdentityAliases) ? model.materialOrderIdentityAliases : [])
    ].map(normalizeMaterialOrderIdentity).filter(Boolean))];
    const matchedOutputs = identities.filter(identity =>
      Object.prototype.hasOwnProperty.call(cumulativeOutputs, identity)
    );
    return matchedOutputs.length > 0
      ? matchedOutputs.reduce((total, identity) => total + getMaterialOrderActualQty(null, cumulativeOutputs[identity]), 0)
      : getMaterialOrderActualQty(model);
  }

  function buildMaterialOrderProductionTotals(productionData = readProductionData(), cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData)) {
    const totals = {};
    Object.entries(productionData.lines || {}).forEach(([lineName, line]) => {
      Object.entries(line.models || {}).forEach(([modelId, model]) => {
        totals[`${lineName}::${modelId}`] = getMaterialOrderCumulativeOutput(lineName, model, cumulativeOutputs);
      });
    });
    return totals;
  }

  function validateMaterialOrderInput(input = {}, productionData = readProductionData()) {
    const order = normalizeMaterialOrderRecord(input);
    const errors = [];
    const seenProductions = new Set();

    if (!order.poMaterial) errors.push('PO Material wajib diisi');
    if (!order.orderMaterial) errors.push('Order Material wajib diisi');
    if (!Number.isInteger(Number(input.qtyOrder)) || Number(input.qtyOrder) <= 0) {
      errors.push('Qty Order harus berupa angka lebih dari 0');
    }
    if (!isValidDateInput(input.orderDate)) errors.push('Tanggal order tidak valid');

    if (order.productions.length === 0) {
      errors.push('Minimal satu line dan model produksi wajib dipilih');
    }

    order.productions.forEach((production, index) => {
      const rowLabel = `Alokasi produksi ${index + 1}`;
      const rawProduction = Array.isArray(input.productions) && input.productions.length > 0
        ? input.productions[index] || {}
        : input;

      if (!production.lineName || !production.modelId) {
        errors.push(`${rowLabel}: line dan model produksi wajib dipilih`);
        return;
      }
      const productionLine = getProductionLine(productionData, production.lineName);
      const model = productionLine?.models?.[production.modelId];
      if (!model) {
        errors.push(`${rowLabel}: line atau model produksi tidak ditemukan`);
      } else {
        production.qtyResult = getMaterialOrderActualQty(model);
      }
      if (!MATERIAL_ORDER_STATUSES.includes(rawProduction.status)) {
        errors.push(`${rowLabel}: Status produksi tidak valid`);
      }

      const productionKey = `${production.lineName}::${production.modelId}`;
      if (seenProductions.has(productionKey)) {
        errors.push(`${rowLabel}: line dan model produksi tidak boleh duplikat`);
      }
      seenProductions.add(productionKey);
    });

    const productionSummary = summarizeMaterialOrderProductionFields(order.productions);
    order.lineName = productionSummary.lineName;
    order.modelId = productionSummary.modelId;
    order.status = deriveMaterialOrderProgressStatus(order.qtyOrder, productionSummary.qtyResult, order.productions);
    order.qtyResult = productionSummary.qtyResult;

    return { order, errors };
  }

  function buildMaterialOrderResponse(order, productionData = readProductionData(), cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData)) {
    const normalizedOrder = normalizeMaterialOrderRecord(order);
    const productions = normalizedOrder.productions.map((production, index) => {
      const productionLine = getProductionLine(productionData, production.lineName);
      const model = productionLine?.models?.[production.modelId];
      const activeModels = productionLine?.activeModels || [];
      const currentProductionOutput = model
        ? getMaterialOrderCumulativeOutput(production.lineName, model, cumulativeOutputs)
        : getMaterialOrderActualQty(null, production.qtyResult);

      return {
        ...production,
        qtyResult: currentProductionOutput,
        allocationIndex: index + 1,
        modelName: model?.model || '',
        labelWeek: model?.labelWeek || '',
        currentProductionOutput,
        productionActive: activeModels.includes(production.modelId)
          || productionLine?.activeModel === production.modelId,
        linkedModelExists: Boolean(model)
      };
    });

    const qtyResult = productions.reduce((total, production) => total + (Number(production.qtyResult) || 0), 0);
    const currentProductionOutput = productions.reduce((total, production) => total + (Number(production.currentProductionOutput) || 0), 0);
    const uniqueLines = [...new Set(productions.map(production => production.lineName).filter(Boolean))];
    const firstProduction = productions[0] || {};

    return {
      ...normalizedOrder,
      productions,
      lineName: uniqueLines.join(', '),
      modelId: productions.length === 1 ? firstProduction.modelId : '',
      modelName: productions.length === 1 ? firstProduction.modelName : '',
      labelWeek: productions.length === 1 ? firstProduction.labelWeek : '',
      status: deriveMaterialOrderProgressStatus(normalizedOrder.qtyOrder, qtyResult, productions),
      qtyResult,
      currentProductionOutput,
      productionActive: productions.some(production => production.productionActive),
      linkedModelExists: productions.length > 0 && productions.every(production => production.linkedModelExists),
      productionCount: productions.length
    };
  }

  function flattenMaterialOrderReportRows(orders, productionData = readProductionData(), cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData)) {
    return (orders || []).map(order => {
      const response = buildMaterialOrderResponse(order, productionData, cumulativeOutputs);
      const allocations = buildMaterialOrderAllocationRows(response);
      return {
        ...response,
        orderId: response.id,
        rowId: String(response.id),
        allocations,
        labelWeek: allocations.map(allocation => `${allocation.allocationIndex}. ${allocation.labelWeek}`).join('\n'),
        modelName: allocations.map(allocation => `${allocation.allocationIndex}. ${allocation.modelName}`).join('\n'),
        lineName: allocations.map(allocation => `${allocation.allocationIndex}. ${allocation.lineNames.join(', ') || '-'}`).join('\n'),
        modelResult: allocations.map(allocation => `${allocation.allocationIndex}. ${allocation.qtyResult}`).join('\n'),
        orderStatus: response.status,
        orderQtyResult: response.qtyResult,
        productionLines: response.productions.map(production => production.lineName)
      };
    });
  }

  function filterMaterialOrderReportRows(orders, filters = {}, productionData = readProductionData(), cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData)) {
    const startDate = filters.startDate || '';
    const endDate = filters.endDate || '';
    const lineName = String(filters.line || '').trim();
    const status = String(filters.status || '').trim();
    const poMaterial = String(filters.poMaterial || '').trim().toLowerCase();

    return flattenMaterialOrderReportRows(orders, productionData, cumulativeOutputs)
      .filter(order => (!startDate || order.orderDate >= startDate)
        && (!endDate || order.orderDate <= endDate)
        && (!lineName || order.productionLines.includes(lineName))
        && (!status || order.status === status)
        && (!poMaterial || String(order.poMaterial || '').trim().toLowerCase() === poMaterial))
      .sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate))
        || (Number(b.orderId) || 0) - (Number(a.orderId) || 0));
  }

  function summarizeMaterialOrderReport(rows = []) {
    const countedOrders = new Map();

    return rows.reduce((summary, row) => {
      const orderKey = Number(row.orderId || row.id) || row.poMaterial;
      if (!countedOrders.has(orderKey)) {
        countedOrders.set(orderKey, true);
        summary.total += 1;
        summary.qtyOrder += Number(row.qtyOrder) || 0;
        if (row.orderStatus === 'in_production') summary.inProduction += 1;
        if (row.orderStatus === 'completed') summary.completed += 1;
      }
      if (countedOrders.get(orderKey) === true) {
        summary.qtyResult += Number(row.orderQtyResult ?? row.qtyResult) || 0;
        countedOrders.set(orderKey, 'summed');
      }
      return summary;
    }, { total: 0, qtyOrder: 0, qtyResult: 0, inProduction: 0, completed: 0 });
  }

  function buildMaterialOrderAllocationRows(order = {}) {
    const groups = new Map();
    const productions = Array.isArray(order.productions) ? order.productions : [];

    productions.forEach(production => {
      const labelWeek = normalizeLabelWeek(production.labelWeek);
      const modelName = String(production.modelName || production.modelId || '').trim();
      const key = labelWeek && modelName
        ? `${normalizeLabelWeekKey(labelWeek)}::${modelName.toLowerCase()}`
        : `${production.lineName || ''}::${production.modelId || ''}`;
      if (!groups.has(key)) groups.set(key, { labelWeek, modelName, lineNames: [], qtyResult: 0 });
      const group = groups.get(key);
      if (production.lineName && !group.lineNames.includes(production.lineName)) {
        group.lineNames.push(production.lineName);
      }
      group.qtyResult += Number(production.qtyResult) || 0;
    });

    const allocationGroups = groups.size > 0
      ? [...groups.values()]
      : [{
          labelWeek: String(order.labelWeek || '').trim(),
          modelName: String(order.modelName || '').trim(),
          lineNames: String(order.lineName || '').split(',').map(value => value.trim()).filter(Boolean),
          qtyResult: Number(order.orderQtyResult ?? order.qtyResult) || 0
        }];

    return allocationGroups.map((group, index) => ({
      allocationIndex: index + 1,
      labelWeek: group.labelWeek || '-',
      modelName: group.modelName || 'Model tidak tersedia',
      lineNames: group.lineNames.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      qtyResult: group.qtyResult
    }));
  }

  async function generateMaterialOrderReportExcel(rows, summary, filters = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Production Dashboard System';

    const summarySheet = workbook.addWorksheet('SUMMARY');
    summarySheet.mergeCells('A1:B1');
    summarySheet.getCell('A1').value = 'REPORT ORDER MATERIAL';
    summarySheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFF' } };
    summarySheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F766E' } };
    summarySheet.getCell('A1').alignment = { horizontal: 'center' };
    [
      ['Periode', filters.startDate && filters.endDate ? `${filters.startDate} s/d ${filters.endDate}` : 'Semua tanggal'],
      ['PO Material', filters.poMaterial || 'Semua PO'],
      ['Status', filters.status ? ({ planned: 'Direncanakan', in_production: 'Sedang Produksi', paused: 'Ditunda', completed: 'Selesai' }[filters.status] || filters.status) : 'Semua status'],
      ['Total PO', summary.total],
      ['Total Qty Order', summary.qtyOrder],
      ['Total Hasil Produksi', summary.qtyResult],
      ['Sedang Produksi', summary.inProduction],
      ['Selesai', summary.completed]
    ].forEach((values, index) => {
      const row = summarySheet.getRow(index + 3);
      row.values = values;
      row.getCell(1).font = { bold: true, color: { argb: '334155' } };
    });
    summarySheet.columns = [{ width: 24 }, { width: 36 }];

    const styleHeader = (sheet, headers, color) => {
      sheet.getRow(1).values = headers;
      sheet.getRow(1).height = 30;
      sheet.getRow(1).eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      });
    };
    const styleDataRow = (row, fillColor, centeredColumns = []) => {
      row.height = 24;
      row.eachCell((cell, columnNumber) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'E2E8F0' } },
          left: { style: 'thin', color: { argb: 'E2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'E2E8F0' } },
          right: { style: 'thin', color: { argb: 'E2E8F0' } }
        };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
        cell.alignment = {
          horizontal: centeredColumns.includes(columnNumber) ? 'center' : 'left',
          vertical: 'middle',
          wrapText: true
        };
      });
    };

    const orderSheet = workbook.addWorksheet('ORDER MATERIAL', { properties: { tabColor: { argb: '0F766E' } } });
    const orderHeaders = ['No', 'Tanggal Order', 'PO Material', 'Order Material', 'Qty Order', 'Total Hasil Produksi', 'Status PO', 'Progress PO', 'Catatan'];
    styleHeader(orderSheet, orderHeaders, '0F766E');
    rows.forEach((order, index) => {
      const qtyOrder = Number(order.qtyOrder) || 0;
      const totalQtyResult = Number(order.orderQtyResult ?? order.qtyResult) || 0;
      const progress = qtyOrder > 0 ? Math.min(100, Math.round((totalQtyResult / qtyOrder) * 100)) : 0;
      const status = { planned: 'Direncanakan', in_production: 'Sedang Produksi', paused: 'Ditunda', completed: 'Selesai' }[order.orderStatus] || order.orderStatus || order.status;
      const row = orderSheet.addRow([
        index + 1,
        order.orderDate,
        order.poMaterial,
        order.orderMaterial,
        qtyOrder,
        totalQtyResult,
        status,
        progress / 100,
        order.notes || ''
      ]);
      styleDataRow(row, index % 2 === 0 ? 'FFFFFF' : 'F8FAFC', [1, 2, 5, 6, 7, 8]);
      row.getCell(3).font = { bold: true, color: { argb: '0F172A' } };
      row.getCell(5).numFmt = '#,##0';
      row.getCell(6).numFmt = '#,##0';
      row.getCell(6).font = { bold: true, color: { argb: '166534' } };
      row.getCell(8).numFmt = '0%';
    });
    orderSheet.columns = [
      { width: 7 }, { width: 15 }, { width: 20 }, { width: 28 }, { width: 15 },
      { width: 21 }, { width: 18 }, { width: 15 }, { width: 32 }
    ];
    orderSheet.views = [{ state: 'frozen', ySplit: 1 }];
    orderSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: orderHeaders.length } };
    orderSheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

    const allocationSheet = workbook.addWorksheet('DETAIL ALOKASI', { properties: { tabColor: { argb: 'D97706' } } });
    const allocationHeaders = ['No', 'PO Material', 'Order Material', 'Alokasi Produksi', 'Label/Week', 'Model Produksi', 'Line Produksi', 'Hasil Produksi'];
    styleHeader(allocationSheet, allocationHeaders, 'D97706');
    let allocationNumber = 1;
    rows.forEach((order, orderIndex) => {
      buildMaterialOrderAllocationRows(order).forEach(allocation => {
        const row = allocationSheet.addRow([
          allocationNumber,
          order.poMaterial,
          order.orderMaterial,
          `Model ${allocation.allocationIndex}`,
          allocation.labelWeek,
          allocation.modelName,
          allocation.lineNames.join(', ') || '-',
          allocation.qtyResult
        ]);
        styleDataRow(row, orderIndex % 2 === 0 ? 'FFFBEB' : 'FFFFFF', [1, 4, 5, 8]);
        row.getCell(2).font = { bold: true, color: { argb: '0F172A' } };
        row.getCell(4).font = { bold: true, color: { argb: 'B45309' } };
        row.getCell(8).numFmt = '#,##0';
        row.getCell(8).font = { bold: true, color: { argb: '166534' } };
        allocationNumber += 1;
      });
    });
    allocationSheet.columns = [
      { width: 7 }, { width: 20 }, { width: 28 }, { width: 18 },
      { width: 15 }, { width: 26 }, { width: 32 }, { width: 18 }
    ];
    allocationSheet.views = [{ state: 'frozen', ySplit: 1 }];
    allocationSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: allocationHeaders.length } };
    allocationSheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

    summarySheet.properties.tabColor = { argb: '334155' };
    [summarySheet, orderSheet, allocationSheet].forEach(sheet => {
      sheet.headerFooter.oddFooter = 'Production Dashboard - Report Order Material';
    });
    return workbook;
  }

  function generateMaterialOrderReportPdf(rows, summary, filters = {}) {
    const statusLabel = status => ({ planned: 'Direncanakan', in_production: 'Sedang Produksi', paused: 'Ditunda', completed: 'Selesai' }[status] || status || '-');
    return createPdfReport({
      title: 'LAPORAN ORDER MATERIAL', subtitle: 'Material planning and production fulfillment control',
      meta: [['PO Material', filters.poMaterial || 'Semua PO'], ['Dicetak', new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })], ['Klasifikasi', 'Internal - Controlled Copy']],
      summary: [['Total PO', summary.total], ['Qty Order', Number(summary.qtyOrder || 0).toLocaleString('id-ID')], ['Hasil Produksi', Number(summary.qtyResult || 0).toLocaleString('id-ID')], ['Sedang Produksi', summary.inProduction], ['Selesai', summary.completed]],
      columns: [{ key: 'no', label: 'No', width: 26 }, { key: 'orderDate', label: 'Tanggal', width: 58 }, { key: 'poMaterial', label: 'PO Material', width: 75 }, { key: 'orderMaterial', label: 'Order Material', width: 100 }, { key: 'labelWeek', label: 'Week', width: 48 }, { key: 'modelName', label: 'Model Produksi', width: 125 }, { key: 'lineName', label: 'Line', width: 70 }, { key: 'qtyOrder', label: 'Qty Order', width: 55 }, { key: 'modelResult', label: 'Hasil / Model', width: 65 }, { key: 'totalResult', label: 'Total Hasil', width: 58 }, { key: 'progress', label: 'Progress', width: 50 }, { key: 'statusText', label: 'Status', width: 75 }],
      rows: rows.map((order, index) => {
        const qtyOrder = Number(order.qtyOrder) || 0;
        const totalResult = Number(order.orderQtyResult ?? order.qtyResult) || 0;
        const modelResult = (order.allocations || []).map(allocation => `${allocation.allocationIndex}. ${Number(allocation.qtyResult || 0).toLocaleString('id-ID')}`).join('\n') || '-';
        return { no: index + 1, orderDate: order.orderDate, poMaterial: order.poMaterial, orderMaterial: String(order.orderMaterial || ''), labelWeek: order.labelWeek || '-', modelName: order.modelName || '-', lineName: order.lineName || '-', qtyOrder: qtyOrder.toLocaleString('id-ID'), modelResult, totalResult: totalResult.toLocaleString('id-ID'), progress: `${qtyOrder ? Math.min(100, Math.round((totalResult / qtyOrder) * 100)) : 0}%`, statusText: statusLabel(order.orderStatus || order.status) };
      })
    });
  }

  return {
    MATERIAL_ORDER_STATUSES,
    buildInitialMaterialOrders,
    buildMaterialOrderCumulativeOutputs,
    buildMaterialOrderProductionTotals,
    buildMaterialOrderResponse,
    deriveMaterialOrderProgressStatus,
    filterMaterialOrderReportRows,
    generateMaterialOrderReportExcel,
    generateMaterialOrderReportPdf,
    normalizeMaterialOrderRecord,
    normalizeMaterialOrders,
    preserveMaterialOrderProductionIdentity,
    summarizeMaterialOrderReport,
    validateMaterialOrderInput
  };
}

module.exports = { createMaterialOrderService };
