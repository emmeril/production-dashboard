function registerImportRoutes(app, dependencies) {
  const {
    PRODUCTION_IMPORT_PREVIEW_TTL_MS,
    applyImportedQcData,
    buildImportedProductionModel,
    buildImportedSewingModel,
    crypto,
    ensureLineActiveModels,
    express,
    flushPendingDatabaseWrites,
    generateModelId,
    getAuthenticatedSessionUser,
    getLatestSnapshotForDate,
    logger,
    parseProductionImportWorkbook,
    parseQcImportWorkbook,
    parseSewingImportWorkbook,
    productionImportPreviewCache,
    productionImportTemplateWorkbook,
    qcImportTemplateWorkbook,
    readProductionSnapshotForDate,
    requireAdmin,
    requireLogin,
    sewingImportTemplateWorkbook,
    storeProductionSnapshot
  } = dependencies;

  function cleanExpiredProductionImportPreviews() {
    const now = Date.now();
    productionImportPreviewCache.forEach((preview, token) => {
      if (now - preview.createdAt > PRODUCTION_IMPORT_PREVIEW_TTL_MS) productionImportPreviewCache.delete(token);
    });
  }

  app.get('/api/production-import/template', requireLogin, requireAdmin, async (req, res) => {
    try {
      const workbook = productionImportTemplateWorkbook();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Template_Import_Data_Produksi.xlsx"');
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      logger.error('Gagal membuat template import produksi', error);
      res.status(500).json({ error: 'Gagal membuat template Excel' });
    }
  });

  app.get('/api/production-import/template/:kind', requireLogin, requireAdmin, async (req, res) => {
    const kind = String(req.params.kind || '').toLowerCase();
    if (!['sewing', 'qc'].includes(kind)) return res.status(404).json({ error: 'Jenis template tidak dikenal' });
    try {
      const workbook = kind === 'sewing' ? sewingImportTemplateWorkbook() : qcImportTemplateWorkbook();
      const filename = kind === 'sewing' ? 'Template_Input_Produksi.xlsx' : 'Template_Input_QC.xlsx';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      logger.error(`Gagal membuat template import ${kind}`, error);
      res.status(500).json({ error: 'Gagal membuat template Excel' });
    }
  });

  function cacheProductionImportPreview(req, parsed, kind) {
    const token = parsed.summary.invalid === 0 && parsed.summary.total > 0
      ? crypto.randomBytes(24).toString('hex')
      : '';
    if (!token) return '';
    const snapshotHashes = {};
    parsed.rows.filter(row => row.errors.length === 0).forEach(row => {
      if (Object.prototype.hasOwnProperty.call(snapshotHashes, row.date)) return;
      snapshotHashes[row.date] = getLatestSnapshotForDate(row.date)?.contentHash || '';
    });
    productionImportPreviewCache.set(token, {
      token,
      kind,
      userId: getAuthenticatedSessionUser(req).id,
      createdAt: Date.now(),
      rows: parsed.rows.filter(row => row.errors.length === 0),
      summary: parsed.summary,
      snapshotHashes,
      filename: String(req.headers['x-file-name'] || 'import.xlsx').slice(0, 150)
    });
    return token;
  }

  app.post('/api/production-import/:kind/preview', requireLogin, requireAdmin,
    express.raw({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/octet-stream'], limit: '10mb' }),
    async (req, res) => {
      const kind = String(req.params.kind || '').toLowerCase();
      if (!['sewing', 'qc'].includes(kind)) return res.status(404).json({ error: 'Jenis import tidak dikenal' });
      cleanExpiredProductionImportPreviews();
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'File Excel wajib diunggah' });
      try {
        const parsed = kind === 'sewing'
          ? await parseSewingImportWorkbook(req.body)
          : await parseQcImportWorkbook(req.body);
        if (parsed.summary.total === 0) return res.status(400).json({ error: `Sheet Data ${kind === 'sewing' ? 'Produksi' : 'QC'} belum berisi data` });
        const token = cacheProductionImportPreview(req, parsed, kind);
        return res.json({ token, rows: parsed.rows, summary: parsed.summary, canImport: Boolean(token), kind });
      } catch (error) {
        logger.warn(`File import ${kind} tidak dapat dibaca: ${error.message}`);
        return res.status(400).json({ error: 'File Excel tidak valid atau rusak' });
      }
    });

  app.post('/api/production-import/:kind/confirm', requireLogin, requireAdmin, async (req, res) => {
    const kind = String(req.params.kind || '').toLowerCase();
    cleanExpiredProductionImportPreviews();
    const token = String(req.body?.token || '');
    const preview = productionImportPreviewCache.get(token);
    const user = getAuthenticatedSessionUser(req);
    if (!preview || preview.userId !== user.id || preview.kind !== kind) {
      return res.status(400).json({ error: 'Review import sudah kedaluwarsa atau jenis import tidak sesuai' });
    }
    for (const [date, expectedHash] of Object.entries(preview.snapshotHashes)) {
      const currentHash = getLatestSnapshotForDate(date)?.contentHash || '';
      if (currentHash !== expectedHash) {
        productionImportPreviewCache.delete(token);
        return res.status(409).json({ error: `Data tanggal ${date} berubah setelah review. Silakan review ulang.` });
      }
    }

    try {
      const snapshots = new Map();
      preview.rows.forEach(row => {
        if (!snapshots.has(row.date)) {
          const source = readProductionSnapshotForDate(row.date);
          snapshots.set(row.date, source ? JSON.parse(JSON.stringify(source)) : { lines: {}, activeLine: '' });
        }
      });
      const safetyFiles = [];
      snapshots.forEach((snapshot, date) => {
        if (getLatestSnapshotForDate(date)) {
          const filename = `data_${date}_${Date.now()}_pre_import_${kind}_${crypto.randomBytes(4).toString('hex')}.json`;
          storeProductionSnapshot(filename, date, 'pre_import', snapshot);
          safetyFiles.push(filename);
        }
      });

      let created = 0;
      let updated = 0;
      preview.rows.forEach(row => {
        const snapshot = snapshots.get(row.date);
        snapshot.lines = snapshot.lines || {};
        const line = ensureLineActiveModels(snapshot.lines[row.line]) || { models: {}, activeModels: [], activeModel: null };
        line.models = line.models || {};
        if (kind === 'sewing') {
          const modelId = row.existingModelId || generateModelId(line.models);
          const existingModel = row.existingModelId ? line.models[row.existingModelId] : null;
          line.models[modelId] = buildImportedSewingModel(row, modelId, existingModel);
          line.activeModels = Array.from(new Set([...(line.activeModels || []), modelId]));
          line.activeModel = line.activeModels[0] || modelId;
          if (existingModel) updated += 1;
          else created += 1;
        } else {
          const model = line.models[row.existingModelId];
          if (!model) throw new Error(`Model QC tidak ditemukan: ${row.line} / ${row.model}`);
          applyImportedQcData(model, row);
          updated += 1;
        }
        snapshot.lines[row.line] = line;
        snapshot.activeLine = snapshot.activeLine || row.line;
      });
      snapshots.forEach((snapshot, date) => storeProductionSnapshot(`data_${date}.json`, date, 'daily', snapshot));
      await flushPendingDatabaseWrites();
      productionImportPreviewCache.delete(token);
      return res.json({
        message: kind === 'sewing'
          ? `Input Produksi berhasil: ${created} model baru, ${updated} model diperbarui`
          : `Input QC berhasil: ${updated} model diperbarui`,
        kind,
        created,
        updated,
        dates: snapshots.size,
        safetyFiles
      });
    } catch (error) {
      logger.error(`Gagal mengonfirmasi import ${kind}`, error);
      return res.status(500).json({ error: `Input ${kind === 'sewing' ? 'Produksi' : 'QC'} gagal disimpan` });
    }
  });

  app.post('/api/production-import/preview', requireLogin, requireAdmin,
    express.raw({ type: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/octet-stream'], limit: '10mb' }),
    async (req, res) => {
      cleanExpiredProductionImportPreviews();
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'File Excel wajib diunggah' });
      }

      try {
        const parsed = await parseProductionImportWorkbook(req.body);
        if (parsed.summary.total === 0) {
          return res.status(400).json({ error: 'Sheet Data Produksi belum berisi data' });
        }
        const token = parsed.summary.invalid === 0 && parsed.summary.total > 0
          ? crypto.randomBytes(24).toString('hex')
          : '';
        if (token) {
          const snapshotHashes = {};
          parsed.rows.filter(row => row.errors.length === 0).forEach(row => {
            if (Object.prototype.hasOwnProperty.call(snapshotHashes, row.date)) return;
            snapshotHashes[row.date] = getLatestSnapshotForDate(row.date)?.contentHash || '';
          });
          productionImportPreviewCache.set(token, {
            token,
            userId: getAuthenticatedSessionUser(req).id,
            createdAt: Date.now(),
            rows: parsed.rows.filter(row => row.errors.length === 0),
            summary: parsed.summary,
            snapshotHashes,
            filename: String(req.headers['x-file-name'] || 'import.xlsx').slice(0, 150)
          });
        }
        return res.json({
          token,
          rows: parsed.rows,
          summary: parsed.summary,
          canImport: Boolean(token)
        });
      } catch (error) {
        logger.warn(`File import produksi tidak dapat dibaca: ${error.message}`);
        return res.status(400).json({ error: 'File Excel tidak valid atau rusak' });
      }
    });

  app.post('/api/production-import/confirm', requireLogin, requireAdmin, async (req, res) => {
    cleanExpiredProductionImportPreviews();
    const token = String(req.body?.token || '');
    const preview = productionImportPreviewCache.get(token);
    const user = getAuthenticatedSessionUser(req);
    if (!preview || preview.userId !== user.id) {
      return res.status(400).json({ error: 'Review import sudah kedaluwarsa. Unggah ulang file Excel.' });
    }

    for (const [date, expectedHash] of Object.entries(preview.snapshotHashes)) {
      const currentHash = getLatestSnapshotForDate(date)?.contentHash || '';
      if (currentHash !== expectedHash) {
        productionImportPreviewCache.delete(token);
        return res.status(409).json({ error: `Data tanggal ${date} berubah setelah review. Silakan lakukan review ulang.` });
      }
    }

    try {
      const snapshots = new Map();
      preview.rows.forEach(row => {
        if (!snapshots.has(row.date)) {
          const source = readProductionSnapshotForDate(row.date);
          snapshots.set(row.date, source ? JSON.parse(JSON.stringify(source)) : { lines: {}, activeLine: '' });
        }
      });

      const safetyFiles = [];
      snapshots.forEach((snapshot, date) => {
        if (getLatestSnapshotForDate(date)) {
          const filename = `data_${date}_${Date.now()}_pre_import_${crypto.randomBytes(4).toString('hex')}.json`;
          storeProductionSnapshot(filename, date, 'pre_import', snapshot);
          safetyFiles.push(filename);
        }
      });

      let created = 0;
      let replaced = 0;
      preview.rows.forEach(row => {
        const snapshot = snapshots.get(row.date);
        snapshot.lines = snapshot.lines || {};
        const line = ensureLineActiveModels(snapshot.lines[row.line])
          || { models: {}, activeModels: [], activeModel: null };
        line.models = line.models || {};
        const modelId = row.existingModelId || generateModelId(line.models);
        line.models[modelId] = buildImportedProductionModel(row, modelId);
        line.activeModels = Array.from(new Set([...(line.activeModels || []), modelId]));
        line.activeModel = line.activeModels[0] || modelId;
        snapshot.lines[row.line] = line;
        snapshot.activeLine = snapshot.activeLine || row.line;
        if (row.action === 'replace') replaced += 1;
        else created += 1;
      });

      snapshots.forEach((snapshot, date) => {
        storeProductionSnapshot(`data_${date}.json`, date, 'daily', snapshot);
      });
      await flushPendingDatabaseWrites();
      productionImportPreviewCache.delete(token);
      return res.json({
        message: `Import berhasil: ${created} data baru, ${replaced} data diperbarui`,
        created,
        replaced,
        dates: snapshots.size,
        safetyFiles
      });
    } catch (error) {
      logger.error('Gagal mengonfirmasi import produksi', error);
      return res.status(500).json({ error: 'Import gagal disimpan' });
    }
  });

  // ENDPOINT UNTUK MENDAPATKAN DAFTAR BACKUP DATA
}

module.exports = { registerImportRoutes };
