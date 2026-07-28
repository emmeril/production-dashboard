function registerMaterialOrderRoutes(app, dependencies) {
  const {
    MATERIAL_ORDER_STATUSES,
    buildMaterialOrderCumulativeOutputs,
    buildMaterialOrderProductionTotals,
    buildMaterialOrderResponse,
    filterMaterialOrderReportRows,
    generateMaterialOrderReportExcel,
    generateNumericId,
    getToday,
    isValidDateInput,
    logger,
    parseNonNegativeInteger,
    readMaterialOrders,
    readProductionData,
    requireMaterialOrderManageAccess,
    requireMaterialOrderViewAccess,
    requireLogin,
    summarizeMaterialOrderReport,
    validateMaterialOrderInput,
    writeMaterialOrders
  } = dependencies;

  app.get('/api/material-orders', requireLogin, requireMaterialOrderViewAccess, async (req, res) => {
    const productionData = readProductionData();
    const cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData);
    const orders = readMaterialOrders().orders
      .map(order => buildMaterialOrderResponse(order, productionData, cumulativeOutputs))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    res.json(orders);
  });

  app.get('/api/material-orders/production-totals', requireLogin, requireMaterialOrderViewAccess, async (req, res) => {
    const productionData = readProductionData();
    const cumulativeOutputs = buildMaterialOrderCumulativeOutputs(productionData);
    res.json(buildMaterialOrderProductionTotals(productionData, cumulativeOutputs));
  });

  app.get('/api/material-orders/report', requireLogin, requireMaterialOrderViewAccess, async (req, res) => {
    const { startDate = '', endDate = '', line = '', status = '', poMaterial = '' } = req.query;
    if ((startDate && !isValidDateInput(startDate)) || (endDate && !isValidDateInput(endDate))) {
      return res.status(400).json({ error: 'Tanggal report tidak valid' });
    }
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ error: 'Tanggal mulai tidak boleh lebih besar dari tanggal selesai' });
    }
    if (status && !MATERIAL_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Status report tidak valid' });
    }

    const filters = { startDate, endDate, line, status, poMaterial };
    const rows = filterMaterialOrderReportRows(readMaterialOrders().orders, filters);
    return res.json({ rows, summary: summarizeMaterialOrderReport(rows), filters });
  });

  app.get('/api/material-orders/report/export', requireLogin, requireMaterialOrderViewAccess, async (req, res) => {
    const { startDate = '', endDate = '', line = '', status = '', poMaterial = '' } = req.query;
    if ((startDate && !isValidDateInput(startDate)) || (endDate && !isValidDateInput(endDate))) {
      return res.status(400).json({ error: 'Tanggal report tidak valid' });
    }
    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({ error: 'Tanggal mulai tidak boleh lebih besar dari tanggal selesai' });
    }
    if (status && !MATERIAL_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Status report tidak valid' });
    }

    try {
      const filters = { startDate, endDate, line, status, poMaterial };
      const rows = filterMaterialOrderReportRows(readMaterialOrders().orders, filters);
      const workbook = await generateMaterialOrderReportExcel(rows, summarizeMaterialOrderReport(rows), filters);
      const buffer = await workbook.xlsx.writeBuffer();
      const dateSuffix = startDate && endDate ? `${startDate}_to_${endDate}` : getToday();
      const lineSuffix = line ? `_${line.replace(/[^a-zA-Z0-9_-]+/g, '_')}` : '';
      const poSuffix = poMaterial ? `_${poMaterial.replace(/[^a-zA-Z0-9_-]+/g, '_')}` : '';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Report_Order_Material${poSuffix}${lineSuffix}_${dateSuffix}.xlsx"`);
      return res.send(buffer);
    } catch (error) {
      logger.error('Gagal export report order material:', error);
      return res.status(500).json({ error: 'Gagal membuat export report order material' });
    }
  });

  app.post('/api/material-orders', requireLogin, requireMaterialOrderManageAccess, async (req, res) => {
    const { order, errors } = validateMaterialOrderInput(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });

    const data = readMaterialOrders();
    const now = new Date().toISOString();
    const savedOrder = {
      ...order,
      id: generateNumericId(data.orders),
      createdBy: req.session.user.name || req.session.user.username,
      createdAt: now,
      updatedAt: now
    };
    data.orders.push(savedOrder);
    await writeMaterialOrders(data);
    return res.status(201).json({
      message: 'Order material berhasil ditambahkan',
      order: buildMaterialOrderResponse(savedOrder)
    });
  });

  app.put('/api/material-orders/:id', requireLogin, requireMaterialOrderManageAccess, async (req, res) => {
    const id = parseNonNegativeInteger(req.params.id);
    const data = readMaterialOrders();
    const index = data.orders.findIndex(order => order.id === id);
    if (index === -1) return res.status(404).json({ error: 'Order material tidak ditemukan' });

    const { order, errors } = validateMaterialOrderInput(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });

    const savedOrder = {
      ...data.orders[index],
      ...order,
      id,
      updatedAt: new Date().toISOString()
    };
    data.orders[index] = savedOrder;
    await writeMaterialOrders(data);
    return res.json({
      message: 'Order material berhasil diperbarui',
      order: buildMaterialOrderResponse(savedOrder)
    });
  });

  app.delete('/api/material-orders/:id', requireLogin, requireMaterialOrderManageAccess, async (req, res) => {
    const id = parseNonNegativeInteger(req.params.id);
    const data = readMaterialOrders();
    const index = data.orders.findIndex(order => order.id === id);
    if (index === -1) return res.status(404).json({ error: 'Order material tidak ditemukan' });

    data.orders.splice(index, 1);
    await writeMaterialOrders(data);
    return res.json({ message: 'Order material berhasil dihapus' });
  });
}

module.exports = { registerMaterialOrderRoutes };
