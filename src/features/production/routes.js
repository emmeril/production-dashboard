const MAX_QC_BATCH_QUANTITY = 1000;

function getUserQcMaxQuantity(user) {
  if (user?.role === 'admin') return MAX_QC_BATCH_QUANTITY;
  if (user?.role !== 'operator') return 1;

  const quantity = parseInt(user.qcMaxQuantity, 10);
  return Number.isInteger(quantity) && quantity > 0
    ? Math.min(quantity, MAX_QC_BATCH_QUANTITY)
    : 5;
}

function registerProductionRoutes(app, dependencies) {
  const {
    ADMIN_OPERATOR_ROLES,
    PPIC_ROLE,
    TARGET_ONLY_LINE_MANAGER_ROLES,
    PRODUCTION_HOURS,
    applyDailyTarget,
    autoCheckDateReset,
    buildLinesResponse,
    buildPublicModelResponse,
    createHourlyData,
    ensureLineActiveModels,
    generateModelId,
    generateNumericId,
    getActiveModel,
    getToday,
    hasAnyRole,
    isValidDateInput,
    isWithinWorkSchedule,
    normalizeLabelWeek,
    normalizeLineName,
    normalizeModelName,
    parseNonNegativeInteger,
    preserveMaterialOrderProductionIdentity,
    readProductionData,
    recalculateModelTotals,
    rejectBlankOperatorProductionOutput,
    rejectUnavailableOperatorProductionHour,
    requireActiveModelForOperator,
    requireAdmin,
    requireLineAccess,
    requireLineManagementAccess,
    requireLogin,
    requireProductionWriteAccess,
    requireQcWriteAccess,
    resolveActiveDefectCategories,
    updateTodayBackup,
    writeProductionData
  } = dependencies;

  app.post('/api/update-hourly/:lineName', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, async (req, res) => {
    const { lineName } = req.params;
    const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;
    const data = readProductionData();
    const active = getActiveModel(data, lineName);

    if (!active || !active.model.hourly_data) {
      return res.status(404).json({ error: 'Line, active model or hourly data not found' });
    }

    const index = parseNonNegativeInteger(hourIndex);
    if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
      return res.status(400).json({ error: 'Invalid hour index' });
    }

  	  const currentHour = active.model.hourly_data[index];
  	  if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;
  	  if (rejectBlankOperatorProductionOutput(req, res, output)) return;
  	  if (hasAnyRole(req.session.user, ['admin_operator_sewing']) && (defect !== undefined || qcChecked !== undefined || defectDetails !== undefined)) {
  	    return res.status(403).json({ error: 'Admin Operator Sewing tidak dapat mengubah data QC' });
  	  }

  	  const nextTargetManual = targetManual !== undefined
  	    ? parseNonNegativeInteger(targetManual)
  	    : parseNonNegativeInteger(currentHour.targetManual, 0);
  	  const nextOutput = parseNonNegativeInteger(output, 0);
  	  const nextDefect = parseNonNegativeInteger(defect, parseNonNegativeInteger(currentHour.defect, 0));
  	  const nextQcChecked = parseNonNegativeInteger(qcChecked, parseNonNegativeInteger(currentHour.qcChecked, 0));
    if ([nextTargetManual, nextOutput, nextDefect, nextQcChecked].includes(null)) {
  	    return res.status(400).json({ error: 'Data produksi dan QC harus berupa bilangan bulat tidak negatif' });
  	  }

    active.model.hourly_data[index] = {
      ...currentHour,
  	    output: nextOutput,
  	    defect: nextDefect,
  	    qcChecked: nextQcChecked,
  	    targetManual: nextTargetManual,
  	    defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
  	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
  	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
  	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
  	    selisih: nextOutput - nextTargetManual
  	  };

    const summary = recalculateModelTotals(active.model);

    await writeProductionData(data);
    updateTodayBackup();

    res.json({
      message: 'Hourly data updated successfully.',
      data: active.model,
      modelId: active.modelId,
      summary: {
        ...summary,
        defectRate: active.model.defectRatePercentage.toFixed(2) + '%'
      }
    });
  });

  app.post('/api/update-target-manual/:lineName', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, async (req, res) => {
    const { lineName } = req.params;
    const { hourIndex, targetManual } = req.body;
    const data = readProductionData();
    const active = getActiveModel(data, lineName);

    if (!active || !active.model.hourly_data) {
      return res.status(404).json({ error: 'Line, active model or hourly data not found' });
    }

    const index = parseNonNegativeInteger(hourIndex);
    if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
      return res.status(400).json({ error: 'Invalid hour index' });
    }

  	  if (rejectUnavailableOperatorProductionHour(req, res, active.model.hourly_data[index])) return;

  	  const nextTargetManual = parseNonNegativeInteger(targetManual);
  	  if (nextTargetManual === null) {
  	    return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
  	  }
    active.model.hourly_data[index].targetManual = nextTargetManual;
    active.model.hourly_data[index].selisih = (parseInt(active.model.hourly_data[index].output) || 0) - nextTargetManual;
    const summary = recalculateModelTotals(active.model);

    await writeProductionData(data);
    updateTodayBackup();

    res.json({
      message: 'Target manual updated successfully.',
      data: active.model.hourly_data[index],
      modelId: active.modelId,
      totalTarget: summary.totalTarget
    });
  });

  app.post('/api/update-hourly-direct/:lineName', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, async (req, res) => {
    const { lineName } = req.params;
    const { hourIndex, output, defect, qcChecked, targetManual } = req.body;
    const data = readProductionData();
    const active = getActiveModel(data, lineName);

    if (!active || !active.model.hourly_data) {
      return res.status(404).json({ error: 'Line, active model or hourly data not found' });
    }

    const index = parseNonNegativeInteger(hourIndex);
    if (!Number.isInteger(index) || index < 0 || index >= active.model.hourly_data.length) {
      return res.status(400).json({ error: 'Invalid hour index' });
    }

  	  const nextOutput = parseNonNegativeInteger(output, 0);
  	  const nextTargetManual = parseNonNegativeInteger(targetManual, 0);
  	  const nextDefect = parseNonNegativeInteger(defect, parseNonNegativeInteger(active.model.hourly_data[index].defect, 0));
  	  const nextQcChecked = parseNonNegativeInteger(qcChecked, parseNonNegativeInteger(active.model.hourly_data[index].qcChecked, 0));
  	  if (hasAnyRole(req.session.user, ['admin_operator_sewing']) && (defect !== undefined || qcChecked !== undefined)) {
  	    return res.status(403).json({ error: 'Admin Operator Sewing tidak dapat mengubah data QC' });
  	  }
  	  if ([nextOutput, nextTargetManual, nextDefect, nextQcChecked].includes(null)) {
  	    return res.status(400).json({ error: 'Data produksi dan QC harus berupa bilangan bulat tidak negatif' });
  	  }
  	  if (rejectUnavailableOperatorProductionHour(req, res, active.model.hourly_data[index])) return;
  	  if (rejectBlankOperatorProductionOutput(req, res, output)) return;

  	  active.model.hourly_data[index] = {
  	    ...active.model.hourly_data[index],
  	    output: nextOutput,
  	    defect: nextDefect,
  	    qcChecked: nextQcChecked,
  	    targetManual: nextTargetManual,
  	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(active.model.hourly_data[index].productionLocked),
  	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : active.model.hourly_data[index].productionLockedAt,
  	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : active.model.hourly_data[index].productionLockedBy,
  	    selisih: nextOutput - nextTargetManual
  	  };

    const summary = recalculateModelTotals(active.model);

    await writeProductionData(data);
    updateTodayBackup();

    res.json({
      message: 'Hourly data updated successfully.',
      data: active.model,
      modelId: active.modelId,
      summary: {
        ...summary,
        defectRate: active.model.defectRatePercentage.toFixed(2) + '%'
      }
    });
  });

  app.post('/api/update-hourly/:lineName/:modelId', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
    const { lineName, modelId } = req.params;
    const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;

    const data = readProductionData();

    if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
      return res.status(404).json({ error: 'Line, model or hourly data not found' });
    }

    const index = parseNonNegativeInteger(hourIndex);
    if (!Number.isInteger(index) || index < 0 || index >= data.lines[lineName].models[modelId].hourly_data.length) {
      return res.status(400).json({ error: 'Invalid hour index' });
    }

    const currentHour = data.lines[lineName].models[modelId].hourly_data[index];
    if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;
    if (rejectBlankOperatorProductionOutput(req, res, output)) return;
    if (hasAnyRole(req.session.user, ['admin_operator_sewing']) && (defect !== undefined || qcChecked !== undefined || defectDetails !== undefined)) {
      return res.status(403).json({ error: 'Admin Operator Sewing tidak dapat mengubah data QC' });
    }
    const nextTargetManual = parseNonNegativeInteger(targetManual, parseNonNegativeInteger(currentHour.targetManual, 0));
    const nextOutput = parseNonNegativeInteger(output, 0);
    const nextDefect = parseNonNegativeInteger(defect, parseNonNegativeInteger(currentHour.defect, 0));
    const nextQcChecked = parseNonNegativeInteger(qcChecked, parseNonNegativeInteger(currentHour.qcChecked, 0));
    if ([nextTargetManual, nextOutput, nextDefect, nextQcChecked].includes(null)) {
      return res.status(400).json({ error: 'Data produksi dan QC harus berupa bilangan bulat tidak negatif' });
    }
    const selisih = nextOutput - nextTargetManual;

    data.lines[lineName].models[modelId].hourly_data[index] = {
      ...currentHour,
      output: nextOutput,
      defect: nextDefect,
      qcChecked: nextQcChecked,
      targetManual: nextTargetManual,
      defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
      productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
      productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
      productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
      selisih: selisih
    };

    const summary = recalculateModelTotals(data.lines[lineName].models[modelId]);

    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI SETELAH MENGUPDATE DATA
    updateTodayBackup();
    
    res.json({
      message: 'Hourly data updated successfully.',
      data: data.lines[lineName].models[modelId],
      summary: {
        ...summary,
        defectRate: data.lines[lineName].models[modelId].defectRatePercentage.toFixed(2) + '%'
      }
    });
  });

  app.post('/api/update-production/:lineName/:modelId', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
    const { lineName, modelId } = req.params;
    const { hourIndex, output, targetManual } = req.body;
    const data = readProductionData();

    if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
      return res.status(404).json({ error: 'Line, model or hourly data not found' });
    }

    const index = parseNonNegativeInteger(hourIndex);
    const model = data.lines[lineName].models[modelId];
    if (!Number.isInteger(index) || index < 0 || index >= model.hourly_data.length) {
      return res.status(400).json({ error: 'Invalid hour index' });
    }

  	  const currentHour = model.hourly_data[index];
  	  if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;
  	  if (rejectBlankOperatorProductionOutput(req, res, output)) return;

    const nextOutput = parseNonNegativeInteger(output, 0);
    const nextTargetManual = parseNonNegativeInteger(targetManual, parseNonNegativeInteger(currentHour.targetManual, 0));
    if (nextOutput === null || nextTargetManual === null) {
      return res.status(400).json({ error: 'Output dan target harus berupa bilangan bulat tidak negatif' });
    }

  	  model.hourly_data[index] = {
  	    ...currentHour,
  	    output: nextOutput,
  	    targetManual: nextTargetManual,
  	    productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
  	    productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
  	    productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
  	    selisih: nextOutput - nextTargetManual
  	  };

    const summary = recalculateModelTotals(model);
    await writeProductionData(data);
    updateTodayBackup();

    res.json({
      message: 'Production data updated successfully.',
      data: model,
      summary: {
        ...summary,
        defectRate: model.defectRatePercentage.toFixed(2) + '%'
      }
    });
  });

  app.post('/api/qc-check/:lineName/:modelId', requireLogin, requireLineAccess, requireQcWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
    if (req.session.user?.role === 'operator') {
      const jakartaTimeParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Jakarta', hour: 'numeric', minute: 'numeric', hour12: false
      }).formatToParts(new Date());
      const jakartaHour = Number(jakartaTimeParts.find(part => part.type === 'hour')?.value || 0) % 24;
      const jakartaMinute = Number(jakartaTimeParts.find(part => part.type === 'minute')?.value || 0);
      const currentMinutes = jakartaHour * 60 + jakartaMinute;
      if (currentMinutes < 7 * 60 || currentMinutes >= 17 * 60) {
        return res.status(403).json({ error: 'Input QC operator hanya dapat dilakukan pukul 07:00-17:00' });
      }
    }
    const { lineName, modelId } = req.params;
    const { result, quantity, hourIndex, type, area, notes } = req.body;
    const data = readProductionData();

    if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
      return res.status(404).json({ error: 'Line or model not found' });
    }

    if (!['good', 'defect'].includes(result)) {
      return res.status(400).json({ error: 'QC result must be good or defect' });
    }

    const parsedQuantity = parseNonNegativeInteger(quantity, 1);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1) {
      return res.status(400).json({ error: 'Qty QC harus berupa bilangan bulat minimal 1' });
    }

    const maxQuantity = getUserQcMaxQuantity(req.session.user);
    if (parsedQuantity > maxQuantity) {
      return res.status(403).json({ error: `Qty QC maksimal untuk akun ini adalah ${maxQuantity}` });
    }

    if (result === 'defect' && (!type || !area)) {
      return res.status(400).json({ error: 'Jenis defect dan area defect wajib dipilih' });
    }

    const defectCategory = result === 'defect'
      ? resolveActiveDefectCategories(type, area)
      : null;
    if (result === 'defect' && !defectCategory.isValid) {
      return res.status(400).json({ error: 'Jenis defect dan area defect harus dipilih dari kategori aktif' });
    }

  	  const model = data.lines[lineName].models[modelId];
  	  model.qcChecks = Array.isArray(model.qcChecks) ? model.qcChecks : [];
  	  const parsedHourIndex = parseNonNegativeInteger(hourIndex);
  	  const validHourIndex = Number.isInteger(parsedHourIndex) && model.hourly_data && model.hourly_data[parsedHourIndex]
  	    ? parsedHourIndex
  	    : null;

  	  const qcCheck = {
  	    id: generateNumericId(model.qcChecks),
  	    result,
      quantity: parsedQuantity,
  	    hourIndex: validHourIndex,
  	    hour: validHourIndex !== null ? model.hourly_data[validHourIndex].hour : '',
  	    type: defectCategory?.type || '',
  	    area: defectCategory?.area || '',
      notes: notes ? String(notes).trim() : '',
      checkedAt: new Date().toISOString()
    };

    model.qcChecks.push(qcCheck);

    const summary = recalculateModelTotals(model);
    await writeProductionData(data);
    updateTodayBackup();

    res.json({
      message: `${result === 'defect' ? 'Defect' : 'Good'} QC ${parsedQuantity} berhasil dicatat.`,
      qcCheck,
      data: model,
      summary: {
        ...summary,
        defectRate: model.defectRatePercentage.toFixed(2) + '%'
      }
    });
  });

  app.post('/api/update-target-manual/:lineName/:modelId', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
    const { lineName, modelId } = req.params;
    const { hourIndex, targetManual } = req.body;

    const data = readProductionData();

  	  if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
  	    return res.status(404).json({ error: 'Line, model or hourly data not found' });
  	  }

  	  const index = parseNonNegativeInteger(hourIndex);
  	  const model = data.lines[lineName].models[modelId];
  	  if (!Number.isInteger(index) || index < 0 || index >= model.hourly_data.length) {
  	    return res.status(400).json({ error: 'Invalid hour index' });
  	  }

  	  const currentHour = model.hourly_data[index];
  	  if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;

  	  const nextTargetManual = parseNonNegativeInteger(targetManual);
  	  if (nextTargetManual === null) {
  	    return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
  	  }

  	  model.hourly_data[index].targetManual = nextTargetManual;
  	  model.hourly_data[index].selisih = (parseNonNegativeInteger(model.hourly_data[index].output, 0) || 0) - nextTargetManual;

  	  let totalTarget = 0;
  	  model.hourly_data.forEach(hour => {
  	    totalTarget += hour.targetManual || 0;
  	  });
  	  model.target = totalTarget;

    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI
    updateTodayBackup();
    
  	  res.json({
  	    message: 'Target manual updated successfully.',
  	    data: model.hourly_data[index],
  	    totalTarget: totalTarget
  	  });
  });

  app.post('/api/update-hourly-direct/:lineName/:modelId', requireLogin, requireLineAccess, requireProductionWriteAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
    const { lineName, modelId } = req.params;
    const { hourIndex, output, defect, qcChecked, targetManual, defectDetails } = req.body;

    const data = readProductionData();

    if (!data.lines[lineName] || !data.lines[lineName].models[modelId] || !data.lines[lineName].models[modelId].hourly_data) {
      return res.status(404).json({ error: 'Line, model or hourly data not found' });
    }

    const index = parseNonNegativeInteger(hourIndex);
    const model = data.lines[lineName].models[modelId];
    if (!Number.isInteger(index) || index < 0 || index >= model.hourly_data.length) {
      return res.status(400).json({ error: 'Invalid hour index' });
    }

    const currentHour = model.hourly_data[index];
    if (rejectUnavailableOperatorProductionHour(req, res, currentHour)) return;
    if (rejectBlankOperatorProductionOutput(req, res, output)) return;

    if (hasAnyRole(req.session.user, ['admin_operator_sewing']) && (defect !== undefined || qcChecked !== undefined || defectDetails !== undefined)) {
      return res.status(403).json({ error: 'Admin Operator Sewing tidak dapat mengubah data QC' });
    }
    const nextOutput = parseNonNegativeInteger(output, 0);
    const nextDefect = parseNonNegativeInteger(defect, parseNonNegativeInteger(currentHour.defect, 0));
    const nextQcChecked = parseNonNegativeInteger(qcChecked, parseNonNegativeInteger(currentHour.qcChecked, 0));
    const nextTargetManual = parseNonNegativeInteger(targetManual, 0);
    if ([nextOutput, nextDefect, nextQcChecked, nextTargetManual].includes(null)) {
      return res.status(400).json({ error: 'Data produksi dan QC harus berupa bilangan bulat tidak negatif' });
    }
    const selisih = nextOutput - nextTargetManual;

    model.hourly_data[index] = {
      ...currentHour,
      output: nextOutput,
      defect: nextDefect,
      qcChecked: nextQcChecked,
      targetManual: nextTargetManual,
      defectDetails: Array.isArray(defectDetails) ? defectDetails : (currentHour.defectDetails || []),
      productionLocked: req.session.user?.role === 'operator' ? true : Boolean(currentHour.productionLocked),
      productionLockedAt: req.session.user?.role === 'operator' ? new Date().toISOString() : currentHour.productionLockedAt,
      productionLockedBy: req.session.user?.role === 'operator' ? req.session.user.username : currentHour.productionLockedBy,
      selisih
    };

    const summary = recalculateModelTotals(model);

    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI
    updateTodayBackup();
    
    res.json({
      message: 'Hourly data updated successfully.',
      data: model,
      summary: {
        ...summary,
        defectRate: model.defectRatePercentage.toFixed(2) + '%'
      }
    });
  });

  app.get('/api/lines', requireLogin, autoCheckDateReset, async (req, res) => {
    const user = req.session.user;
    const role = user.role === 'admin_operator' ? 'admin_operator_sewing' : user.role;
    const data = readProductionData();
    
    if (role === 'admin' || ADMIN_OPERATOR_ROLES.includes(role) || role === PPIC_ROLE) {
      return res.json(buildLinesResponse(data.lines || {}));
    }
    
    if (role === 'operator') {
      const operatorLine = {};
      if (data.lines[user.line]) {
        operatorLine[user.line] = data.lines[user.line];
      }
      return res.json(buildLinesResponse(operatorLine));
    }
    
    res.status(403).json({ error: 'Access denied' });
  });

  app.get('/api/lines/:lineName/models', requireLogin, requireLineAccess, autoCheckDateReset, async (req, res) => {
    const { lineName } = req.params;
    const data = readProductionData();

    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    res.json(data.lines[lineName].models || {});
  });

  app.post('/api/lines', requireLogin, requireLineManagementAccess, async (req, res) => {
    const { lineName, labelWeek, model, target, date } = req.body;
    const data = readProductionData();
    const normalizedLine = normalizeLineName(lineName);
    const normalizedModel = normalizeModelName(model);
    if (normalizedLine.error) return res.status(400).json({ error: normalizedLine.error });
    if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });

    if (data.lines[normalizedLine.value]) {
      return res.status(400).json({ error: 'Line already exists' });
    }

    const lineDate = date || getToday();
    const parsedTarget = parseNonNegativeInteger(target);
    if (parsedTarget === null) {
      return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
    }
    if (!isValidDateInput(lineDate) || lineDate !== getToday()) {
      return res.status(400).json({ error: 'Tanggal line/model harus menggunakan tanggal operasional hari ini' });
    }
    const targetPerHour = Math.round(parsedTarget / PRODUCTION_HOURS.length);
    const modelId = 'model1';

    data.lines[normalizedLine.value] = {
      models: {
        [modelId]: {
          id: modelId,
          labelWeek: normalizeLabelWeek(labelWeek),
          model: normalizedModel.value,
          date: lineDate,
          target: parsedTarget,
          targetPerHour: targetPerHour,
          outputDay: 0,
          qcChecking: 0,
          actualDefect: 0,
          defectRatePercentage: 0,
          hourly_data: createHourlyData(parsedTarget),
          operators: []
        }
      },
      activeModel: modelId,
      activeModels: [modelId]
    };

    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI
    updateTodayBackup();
    
    res.json({ 
      message: `Line ${normalizedLine.value} created successfully`,
      data: data.lines[normalizedLine.value],
      calculated: {
        targetPerHour: targetPerHour,
        message: `Target per jam: ${targetPerHour} unit (Target: ${target} ÷ 8 jam efektif)`
      }
    });
  });

  app.post('/api/lines/:lineName/models', requireLogin, requireLineManagementAccess, async (req, res) => {
    const { lineName } = req.params;
    const { labelWeek, model, target, date } = req.body;
    const data = readProductionData();
    const normalizedModel = normalizeModelName(model);
    if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });

    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    const lineDate = date || getToday();
    const parsedTarget = parseNonNegativeInteger(target);
    if (parsedTarget === null) {
      return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
    }
    if (!isValidDateInput(lineDate) || lineDate !== getToday()) {
      return res.status(400).json({ error: 'Tanggal line/model harus menggunakan tanggal operasional hari ini' });
    }
    const targetPerHour = Math.round(parsedTarget / PRODUCTION_HOURS.length);
    const modelId = generateModelId(data.lines[lineName].models);

    data.lines[lineName].models[modelId] = {
      id: modelId,
      labelWeek: normalizeLabelWeek(labelWeek),
      model: normalizedModel.value,
      date: lineDate,
      target: parsedTarget,
      targetPerHour: targetPerHour,
      outputDay: 0,
      qcChecking: 0,
      actualDefect: 0,
      defectRatePercentage: 0,
      hourly_data: createHourlyData(parsedTarget),
      operators: []
    };

    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI
    updateTodayBackup();
    
    res.json({ 
      message: `Model ${modelId} added to line ${lineName} successfully`, 
      data: data.lines[lineName].models[modelId],
      modelId: modelId
    });
  });

  app.put('/api/lines/:lineName', requireLogin, requireLineManagementAccess, autoCheckDateReset, async (req, res) => {
    const lineName = req.params.lineName;
    const { labelWeek, model, target, modelId, date } = req.body;
    const hasTargetOnlyLineAccess = hasAnyRole(req.session.user, TARGET_ONLY_LINE_MANAGER_ROLES);
    const data = readProductionData();

    if (hasTargetOnlyLineAccess) {
      const allowedFields = new Set(['lineName', 'modelId', 'target']);
      const unsupportedFields = Object.keys(req.body).filter(field => !allowedFields.has(field));
      if (unsupportedFields.length > 0) {
        return res.status(403).json({ error: 'Role ini hanya dapat mengubah Target Harian' });
      }
    }

    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    const targetModelId = modelId || data.lines[lineName].activeModel;
    if (!data.lines[lineName].models[targetModelId]) {
      return res.status(404).json({ error: 'Model not found' });
    }

    const newTarget = parseNonNegativeInteger(target);
    if (newTarget === null) {
      return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
    }
    if (date !== undefined && (!isValidDateInput(date) || date !== getToday())) {
      return res.status(400).json({ error: 'Tanggal line/model harus menggunakan tanggal operasional hari ini' });
    }

    const targetModel = data.lines[lineName].models[targetModelId];
    if (!hasTargetOnlyLineAccess) {
      const nextLabelWeek = labelWeek === undefined ? targetModel.labelWeek : normalizeLabelWeek(labelWeek);
      const normalizedModel = model === undefined ? { value: targetModel.model, error: '' } : normalizeModelName(model);
      if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });
      const nextModelName = normalizedModel.value;
      preserveMaterialOrderProductionIdentity(lineName, targetModel, nextLabelWeek, nextModelName);
      targetModel.labelWeek = nextLabelWeek;
      targetModel.model = nextModelName;
    }
    targetModel.target = newTarget;
    applyDailyTarget(targetModel, newTarget);
    
    if (!hasTargetOnlyLineAccess && date) {
      targetModel.date = date;
    }

    let totalTarget = 0;
    targetModel.hourly_data.forEach(hour => {
      totalTarget += hour.targetManual || 0;
    });
    targetModel.target = totalTarget;

    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI
    updateTodayBackup();
    
    res.json({ 
      message: `Model ${targetModelId} in line ${lineName} updated successfully`, 
      data: targetModel
    });
  });

  app.delete('/api/lines/:lineName/models/:modelId', requireLogin, requireAdmin, async (req, res) => {
    const { lineName, modelId } = req.params;
    const data = readProductionData();

    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    if (!data.lines[lineName].models[modelId]) {
      return res.status(404).json({ error: 'Model not found' });
    }

    if (Object.keys(data.lines[lineName].models).length === 1) {
      return res.status(400).json({ error: 'Cannot delete the last model in a line' });
    }

    delete data.lines[lineName].models[modelId];

    if (Array.isArray(data.lines[lineName].activeModels)) {
      data.lines[lineName].activeModels = data.lines[lineName].activeModels.filter(activeId => activeId !== modelId);
    }

    if (data.lines[lineName].activeModel === modelId) {
      const remainingActive = (data.lines[lineName].activeModels || []).filter(activeId => data.lines[lineName].models[activeId]);
      data.lines[lineName].activeModel = remainingActive[0] || Object.keys(data.lines[lineName].models)[0];
    }

    if (!Array.isArray(data.lines[lineName].activeModels) || data.lines[lineName].activeModels.length === 0) {
      data.lines[lineName].activeModels = [data.lines[lineName].activeModel];
    }

    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI
    updateTodayBackup();
    
    res.json({ message: `Model ${modelId} deleted from line ${lineName} successfully` });
  });

  app.delete('/api/lines/:lineName', requireLogin, requireAdmin, async (req, res) => {
    const lineName = req.params.lineName;
    const data = readProductionData();

    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    delete data.lines[lineName];
    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI
    updateTodayBackup();
    
    res.json({ message: `Line ${lineName} deleted successfully` });
  });

  app.post('/api/lines/:lineName/active-model', requireLogin, requireLineManagementAccess, autoCheckDateReset, async (req, res) => {
    const { lineName } = req.params;
    const { modelId } = req.body;
    const data = readProductionData();

    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    if (!data.lines[lineName].models[modelId]) {
      return res.status(404).json({ error: 'Model not found' });
    }

    const line = ensureLineActiveModels(data.lines[lineName]);
    const activeModels = new Set(line.activeModels || []);
    const isActive = activeModels.has(modelId);

    if (isActive) {
      if (activeModels.size <= 1) {
        return res.status(400).json({ error: 'Line harus memiliki minimal 1 model aktif' });
      }
      activeModels.delete(modelId);
    } else {
      activeModels.add(modelId);
    }

    line.activeModels = Array.from(activeModels);
    line.activeModel = line.activeModels[0] || null;
    await writeProductionData(data);
    
    // UPDATE BACKUP HARI INI
    updateTodayBackup();
    
    res.json({ 
      message: isActive
        ? 'Model ' + modelId + ' dinonaktifkan dari line ' + lineName
        : 'Model ' + modelId + ' diaktifkan pada line ' + lineName,
      activeModel: line.activeModel,
      activeModels: line.activeModels
    });
  });

  app.get('/api/line/:lineName/:modelId', requireLogin, requireLineAccess, autoCheckDateReset, requireActiveModelForOperator, async (req, res) => {
    const { lineName, modelId } = req.params;
    const data = readProductionData();
    
    if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
      return res.status(404).json({ error: 'Line or model not found' });
    }

    const modelData = data.lines[lineName].models[modelId];
    res.json({ 
      line: lineName,
      modelId: modelId,
      ...modelData 
    });
  });

  app.get('/api/line/:lineName', requireLogin, requireLineAccess, autoCheckDateReset, async (req, res) => {
    const { lineName } = req.params;
    const data = readProductionData();
    
    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    const activeModel = getActiveModel(data, lineName);
    if (!activeModel) {
      return res.status(404).json({ error: 'Active model not found' });
    }

    res.json({ 
      line: lineName,
      modelId: activeModel.modelId,
      ...activeModel.model 
    });
  });

  app.post('/api/update-line/:lineName/:modelId', requireLogin, requireLineAccess, requireLineManagementAccess, autoCheckDateReset, async (req, res) => {
    const { lineName, modelId } = req.params;
    const newData = req.body;
    const hasTargetOnlyLineAccess = hasAnyRole(req.session.user, TARGET_ONLY_LINE_MANAGER_ROLES);

    if (hasTargetOnlyLineAccess) {
      const unsupportedFields = Object.keys(newData).filter(field => field !== 'target');
      if (unsupportedFields.length > 0) {
        return res.status(403).json({ error: 'Role ini hanya dapat mengubah Target Harian' });
      }
    }

    const data = readProductionData();

    if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
      return res.status(404).json({ error: 'Line or model not found' });
    }

    const model = data.lines[lineName].models[modelId];
    const hasDate = Object.prototype.hasOwnProperty.call(newData, 'date');
    const nextDate = hasDate ? String(newData.date || '').trim() : model.date;
    const hasTarget = Object.prototype.hasOwnProperty.call(newData, 'target');
    const nextTarget = hasTarget ? parseNonNegativeInteger(newData.target) : null;

    if (hasDate && (!isValidDateInput(nextDate) || nextDate !== getToday())) {
      return res.status(400).json({ error: 'Tanggal line/model harus menggunakan tanggal operasional hari ini' });
    }
    if (hasTarget && nextTarget === null) {
      return res.status(400).json({ error: 'Target harus berupa bilangan bulat tidak negatif' });
    }

    if (Object.prototype.hasOwnProperty.call(newData, 'labelWeek')) {
      const nextLabelWeek = normalizeLabelWeek(newData.labelWeek);
      const normalizedModel = Object.prototype.hasOwnProperty.call(newData, 'model')
        ? normalizeModelName(newData.model)
        : { value: model.model, error: '' };
      if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });
      const nextModelName = normalizedModel.value;
      preserveMaterialOrderProductionIdentity(lineName, model, nextLabelWeek, nextModelName);
      model.labelWeek = nextLabelWeek;
      if (Object.prototype.hasOwnProperty.call(newData, 'model')) model.model = nextModelName;
    } else if (Object.prototype.hasOwnProperty.call(newData, 'model')) {
      const normalizedModel = normalizeModelName(newData.model);
      if (normalizedModel.error) return res.status(400).json({ error: normalizedModel.error });
      const nextModelName = normalizedModel.value;
      preserveMaterialOrderProductionIdentity(lineName, model, model.labelWeek, nextModelName);
      model.model = nextModelName;
    }
    if (hasDate) {
      model.date = nextDate;
    }
    if (hasTarget) {
      applyDailyTarget(model, nextTarget);
    }

    recalculateModelTotals(model);

    await writeProductionData(data);
    
    // ✅ UPDATE BACKUP HARI INI
    updateTodayBackup();
    
    res.json({ message: `Model ${modelId} in line ${lineName} updated successfully.`, data: model });
  });

  app.get('/api/public/line/:lineName', autoCheckDateReset, async (req, res) => {
    if (!isWithinWorkSchedule()) {
      return res.status(403).json({ error: 'Public display hanya tersedia pada hari dan jam kerja' });
    }

    const lineName = req.params.lineName;
    const data = readProductionData();
    
    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    const activeModel = getActiveModel(data, lineName);
    if (!activeModel) {
      return res.status(404).json({ error: 'Active model not found' });
    }

    res.json(buildPublicModelResponse(activeModel.model));
  });

  app.get('/api/public/line/:lineName/active-models', autoCheckDateReset, async (req, res) => {
    if (!isWithinWorkSchedule()) {
      return res.status(403).json({ error: 'Public display hanya tersedia pada hari dan jam kerja' });
    }

    const { lineName } = req.params;
    const data = readProductionData();

    if (!data.lines[lineName]) {
      return res.status(404).json({ error: 'Line not found' });
    }

    const line = ensureLineActiveModels(data.lines[lineName]);
    const activeModels = (line.activeModels || []).filter(modelId => line.models?.[modelId]);

    if (activeModels.length === 0) {
      return res.status(404).json({ error: 'Active model not found' });
    }

    res.json({
      lineName,
      activeModels: activeModels.map(modelId => ({
        modelId,
        data: buildPublicModelResponse(line.models[modelId])
      }))
    });
  });

  app.get('/api/public/line/:lineName/:modelId', autoCheckDateReset, async (req, res) => {
    if (!isWithinWorkSchedule()) {
      return res.status(403).json({ error: 'Public display hanya tersedia pada hari dan jam kerja' });
    }

    const { lineName, modelId } = req.params;
    const data = readProductionData();
    
    if (!data.lines[lineName] || !data.lines[lineName].models[modelId]) {
      return res.status(404).json({ error: 'Line or model not found' });
    }

    const modelData = data.lines[lineName].models[modelId];

    res.json(buildPublicModelResponse(modelData));
  });
}

module.exports = { getUserQcMaxQuantity, registerProductionRoutes };
