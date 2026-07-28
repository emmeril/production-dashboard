function registerBackupRoutes(app, dependencies) {
  const {
    ExcelJS,
    clearSessionsAfterDatabaseRestore,
    createArchiveBackup,
    createDatabaseBackup,
    databasePath,
    databaseRestoreState,
    flushPendingDatabaseWrites,
    fs,
    getLegacyHistoryJsonFiles,
    getSnapshotByFilename,
    getToday,
    isSafeBackupFilename,
    isValidProductionSnapshot,
    listDatabaseBackupFiles,
    logger,
    migrateLegacyHistoryToDatabase,
    path,
    productionSnapshotCache,
    readProductionData,
    readSnapshotData,
    recoverProductionSnapshotsFromDatabaseBackups,
    requireAdmin,
    requireLogin,
    restoreDatabaseBackupFile,
    restoreProductionSnapshot,
    updateTodayBackup,
    writeProductionData
  } = dependencies;

  app.get('/api/backup-history', requireLogin, requireAdmin, async (req, res) => {
    try {
      const snapshotBackups = Array.from(productionSnapshotCache.values()).map(snapshot => ({
        filename: snapshot.filename,
        date: snapshot.snapshotDate,
        type: snapshot.type,
        size: snapshot.size,
        created: snapshot.updatedAt,
        storage: 'snapshot',
        restorable: true,
        exportable: true,
        displayDate: new Date(snapshot.snapshotDate + 'T00:00:00+07:00').toLocaleDateString('id-ID')
      }));
      const databaseBackups = listDatabaseBackupFiles().map(backup => ({
        filename: backup.filename,
        date: backup.date,
        type: 'database',
        size: backup.size,
        created: backup.created,
        storage: 'database',
        restorable: false,
        exportable: false,
        displayDate: backup.date ? new Date(backup.date + 'T00:00:00+07:00').toLocaleDateString('id-ID') : '-'
      }));
      const backupFiles = [...snapshotBackups, ...databaseBackups]
        .sort((a, b) => new Date(b.created) - new Date(a.created));
      
      res.json(backupFiles);
    } catch (error) {
      logger.error('Gagal membaca riwayat backup', error);
      res.status(500).json({ error: 'Failed to read backup history' });
    }
  });

  // ENDPOINT UNTUK MEMULIHKAN DATA DARI BACKUP
  app.post('/api/restore-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
    const { filename } = req.params;
    
    if (!isSafeBackupFilename(filename)) {
      return res.status(400).json({ error: 'Invalid backup filename' });
    }

    try {
      const snapshot = getSnapshotByFilename(filename);
      if (!snapshot) {
        return res.status(404).json({ error: 'Backup file not found' });
      }
      const backupData = readSnapshotData(snapshot);
      if (!isValidProductionSnapshot(backupData)) {
        return res.status(400).json({ error: 'Backup tidak memiliki struktur data produksi yang valid' });
      }

      const safetyBackupFile = createArchiveBackup('pre_restore');
      if (!safetyBackupFile) {
        return res.status(500).json({ error: 'Gagal membuat backup pengaman sebelum restore' });
      }
      const safetyDatabaseFile = await createDatabaseBackup('pre_restore');
      
      logger.info(`Restore backup dimulai: ${filename}`);
      const restoreResult = restoreProductionSnapshot(readProductionData(), backupData, getToday());
      const currentData = restoreResult.data;
      
      await writeProductionData(currentData);
      
      // Keep the restored state durable before the browser reloads dashboard data.
      updateTodayBackup();
      await flushPendingDatabaseWrites();
      
      res.json({
        message: '✅ Backup restored successfully',
        restoredLines: restoreResult.restoredLines,
        restoredModels: restoreResult.restoredModels,
        replacedModels: restoreResult.replacedModels,
        normalizedDateModels: restoreResult.normalizedDateModels,
        operationalDate: getToday(),
        safetyBackup: path.basename(safetyBackupFile),
        safetyDatabaseBackup: path.basename(safetyDatabaseFile),
        totalLines: Object.keys(currentData.lines).length,
        totalModels: Object.keys(currentData.lines).reduce((total, lineName) => {
          return total + Object.keys(currentData.lines[lineName].models).length;
        }, 0)
      });
    } catch (error) {
      logger.error('Gagal memulihkan backup', error);
      res.status(500).json({ error: 'Failed to restore backup: ' + error.message });
    }
  });

  app.get('/api/download-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
    const { filename } = req.params;
    const snapshot = isSafeBackupFilename(filename) ? getSnapshotByFilename(filename) : null;

    if (!snapshot) {
      return res.status(isSafeBackupFilename(filename) ? 404 : 400).json({
        error: isSafeBackupFilename(filename) ? 'Backup file not found' : 'Invalid backup filename'
      });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('application/json').send(snapshot.payload);
  });

  app.get('/api/download-database-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
    const { filename } = req.params;
    const backup = listDatabaseBackupFiles().find(item => item.filename === filename);
    if (!backup) return res.status(404).json({ error: 'Database backup not found' });
    res.download(backup.path, backup.filename);
  });

  app.post('/api/restore-database-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
    if (req.body?.confirmation !== 'RESTORE') {
      return res.status(400).json({ error: 'Ketik RESTORE untuk mengonfirmasi pemulihan database' });
    }
    if (databaseRestoreState.value) {
      return res.status(409).json({ error: 'Restore database lain sedang berlangsung' });
    }

    const backup = listDatabaseBackupFiles().find(item => item.filename === req.params.filename);
    if (!backup) return res.status(404).json({ error: 'File backup database tidak ditemukan' });

    databaseRestoreState.value = true;
    try {
      logger.info(`Restore database dimulai: ${backup.filename}`);
      const result = await restoreDatabaseBackupFile(backup.path);
      try {
        await clearSessionsAfterDatabaseRestore(req);
      } catch (sessionError) {
        logger.warn(`Database pulih tetapi sesi lama gagal dibersihkan: ${sessionError.message}`);
      }
      return res.json({
        message: 'Database berhasil dipulihkan',
        ...result
      });
    } catch (error) {
      logger.error(`Restore database gagal (${backup.filename})`, error);
      return res.status(error.code === 'INVALID_DATABASE_BACKUP' ? 400 : 500).json({
        error: error.code === 'INVALID_DATABASE_BACKUP'
          ? error.message
          : 'Restore database gagal. Database pengaman tetap dipertahankan.'
      });
    } finally {
      databaseRestoreState.value = false;
    }
  });

  // ENDPOINT UNTUK EXPORT BACKUP KE EXCEL
  app.get('/api/export-backup/:filename', requireLogin, requireAdmin, async (req, res) => {
    const { filename } = req.params;
    
    if (!isSafeBackupFilename(filename)) {
      return res.status(400).json({ error: 'Invalid backup filename' });
    }

    try {
      const snapshot = getSnapshotByFilename(filename);
      if (!snapshot) return res.status(404).json({ error: 'Backup file not found' });
      const backupData = readSnapshotData(snapshot);
      const date = snapshot.snapshotDate;
      
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
      
      const summarySheet = workbook.addWorksheet('BACKUP SUMMARY');
      
  	  summarySheet.mergeCells('A1:H1');
      const titleCell = summarySheet.getCell('A1');
      titleCell.value = `BACKUP DATA - ${date}`;
      titleCell.style = titleStyle;
      
      summarySheet.getCell('A3').value = 'Backup File';
      summarySheet.getCell('B3').value = filename;
      summarySheet.getCell('A4').value = 'Backup Date';
      summarySheet.getCell('B4').value = date;
      summarySheet.getCell('A5').value = 'Generated Date';
      summarySheet.getCell('B5').value = backupData.backupDate || new Date().toISOString();
      summarySheet.getCell('A6').value = 'Total Lines';
      summarySheet.getCell('B6').value = Object.keys(backupData.lines).length;
      
      const headers = ['Line', 'Model ID', 'Label/Week', 'Model', 'Date', 'Target', 'Output', 'Defect Rate %'];
      summarySheet.getRow(8).values = headers;
      summarySheet.getRow(8).eachCell((cell) => {
        cell.style = headerStyle;
      });
      
      let rowIndex = 9;
      Object.keys(backupData.lines).forEach(lineName => {
        const line = backupData.lines[lineName];
        Object.keys(line.models).forEach(modelId => {
          const model = line.models[modelId];
          
          const row = summarySheet.getRow(rowIndex);
          row.values = [
            lineName,
            modelId,
            model.labelWeek || '',
            model.model || '',
            model.date || '',
            model.target || 0,
            model.outputDay || 0,
            (model.defectRatePercentage || 0) + '%'
          ];
          
          row.eachCell((cell) => {
            cell.style = dataStyle;
          });
          
          rowIndex++;
        });
      });
      
      summarySheet.columns = [
        { width: 15 },
        { width: 12 },
        { width: 15 },
        { width: 30 },
        { width: 12 },
        { width: 12 },
        { width: 12 },
        { width: 15 }
      ];
      
      Object.keys(backupData.lines).forEach(lineName => {
        const line = backupData.lines[lineName];
        const lineSheet = workbook.addWorksheet(lineName.substring(0, 31));
        
        let currentRow = 1;
        
        lineSheet.mergeCells(`A${currentRow}:G${currentRow}`);
        const lineTitle = lineSheet.getCell(`A${currentRow}`);
        lineTitle.value = `BACKUP DATA - ${lineName} - ${date}`;
        lineTitle.style = titleStyle;
        currentRow += 2;
        
        Object.keys(line.models).forEach(modelId => {
          const model = line.models[modelId];
          
          lineSheet.getCell(`A${currentRow}`).value = 'Model ID';
          lineSheet.getCell(`B${currentRow}`).value = modelId;
          currentRow++;
          
          lineSheet.getCell(`A${currentRow}`).value = 'Label/Week';
          lineSheet.getCell(`B${currentRow}`).value = model.labelWeek || '';
          currentRow++;
          
          lineSheet.getCell(`A${currentRow}`).value = 'Model';
          lineSheet.getCell(`B${currentRow}`).value = model.model || '';
          currentRow++;
          
  	      lineSheet.getCell(`A${currentRow}`).value = 'Tanggal';
          lineSheet.getCell(`B${currentRow}`).value = model.date || '';
          currentRow++;
          
          lineSheet.getCell(`A${currentRow}`).value = 'Target';
          lineSheet.getCell(`B${currentRow}`).value = model.target || 0;
          currentRow++;
          
          lineSheet.getCell(`A${currentRow}`).value = 'Output';
          lineSheet.getCell(`B${currentRow}`).value = model.outputDay || 0;
          currentRow++;
          
          lineSheet.getCell(`A${currentRow}`).value = 'Defect Rate';
          lineSheet.getCell(`B${currentRow}`).value = (model.defectRatePercentage || 0) + '%';
          currentRow += 2;
          
          const hourlyHeaders = ['Jam', 'Target Manual', 'Output', 'Selisih', 'Defect', 'QC Checked', 'Defect Rate %'];
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
                defectRate + '%'
              ];
              
              row.eachCell((cell) => {
                cell.style = dataStyle;
              });
              
              currentRow++;
            });
          }
          
          currentRow += 3;
        });
        
        lineSheet.columns = [
          { width: 15 },
          { width: 25 },
          { width: 12 },
          { width: 12 },
          { width: 12 },
          { width: 15 },
          { width: 15 }
        ];
      });
      
      const downloadFilename = `Backup_Data_${date}.xlsx`;
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      
      await workbook.xlsx.write(res);
    } catch (error) {
      logger.error('Gagal mengekspor backup', error);
      res.status(500).json({ error: 'Failed to export backup: ' + error.message });
    }
  });

  // ENDPOINT UNTUK MENGORGANISIR FILE BACKUP
  app.post('/api/organize-backups', requireLogin, requireAdmin, async (req, res) => {
    try {
      const legacyCount = getLegacyHistoryJsonFiles().length;
      await migrateLegacyHistoryToDatabase();
      const recoveredCount = await recoverProductionSnapshotsFromDatabaseBackups();
      res.json({
        message: '✅ Snapshot lama sudah dimigrasikan dan dipulihkan ke database',
        movedCount: legacyCount,
        recoveredCount,
        backupDir: databaseBackupDir
      });
    } catch (error) {
      logger.error('Gagal mengatur backup', error);
      res.status(500).json({ error: 'Failed to organize backups: ' + error.message });
    }
  });

  // ENDPOINT UNTUK CEK STATUS SISTEM
  app.get('/api/system-status', requireLogin, requireAdmin, async (req, res) => {
    const data = readProductionData();
    const today = getToday();
    const now = new Date();
    
    let modelCount = 0;
    let todayModelCount = 0;
    let otherDateModelCount = 0;
    const modelDates = {};
    
    Object.keys(data.lines).forEach(lineName => {
      const line = data.lines[lineName];
      Object.keys(line.models).forEach(modelId => {
        const model = line.models[modelId];
        modelCount++;
        
        if (model.date === today) {
          todayModelCount++;
        } else {
          otherDateModelCount++;
          if (!modelDates[model.date]) {
            modelDates[model.date] = 0;
          }
          modelDates[model.date]++;
        }
      });
    });
    
    const databaseBackups = listDatabaseBackupFiles();
    const backupCount = productionSnapshotCache.size + databaseBackups.length;
    const latestSnapshot = Array.from(productionSnapshotCache.values())
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const lastBackupCandidates = [
      latestSnapshot ? { filename: latestSnapshot.filename, size: latestSnapshot.size, created: latestSnapshot.updatedAt } : null,
      databaseBackups[0] || null
    ].filter(Boolean).sort((a, b) => new Date(b.created) - new Date(a.created));
    const lastBackup = lastBackupCandidates[0] || null;
    
    res.json({
      systemTime: now.toLocaleString('id-ID'),
      systemTimeUTC: now.toISOString(),
      today: today,
      modelCount: modelCount,
      todayModelCount: todayModelCount,
      otherDateModelCount: otherDateModelCount,
      modelDates: modelDates,
      backupCount: backupCount,
      lastBackup: lastBackup,
      dataSize: fs.existsSync(databasePath) ? fs.statSync(databasePath).size : Buffer.byteLength(JSON.stringify(data), 'utf8'),
      needsSync: otherDateModelCount > 0
    });
  });

  // ENDPOINT UNTUK MENDAPATKAN DAFTAR TANGGAL YANG TERSEDIA
}

function registerHistoryRoutes(app, dependencies) {
  const {
    XLSX,
    checkAndResetDataForNewDay,
    createDatabaseBackup,
    extractHistoryDate,
    fs,
    getHistoryFiles,
    getSnapshotByFilename,
    getToday,
    isSafeHistoryFilename,
    logger,
    path,
    readHistoryData,
    requireAdmin,
    requireLogin
  } = dependencies;

  app.get('/api/history/files', requireLogin, requireAdmin, async (req, res) => {
    try {
      const historyFiles = getHistoryFiles();
      res.json(historyFiles);
    } catch (error) {
      logger.error('Gagal mengambil file histori', error);
      res.status(500).json({ error: 'Failed to get history files' });
    }
  });

  app.get('/api/history/:filename', requireLogin, requireAdmin, async (req, res) => {
    const { filename } = req.params;
    
    if (!isSafeHistoryFilename(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    try {
      const historyData = readHistoryData(filename);
      if (!historyData) {
        return res.status(404).json({ error: 'History file not found' });
      }
      res.json(historyData);
    } catch (error) {
      logger.error('Gagal membaca file histori', error);
      res.status(500).json({ error: 'Failed to read history data' });
    }
  });

  app.get('/api/history/:filename/export', requireLogin, requireAdmin, async (req, res) => {
    const { filename } = req.params;
    
    if (!isSafeHistoryFilename(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    try {
      const historyData = readHistoryData(filename);
      if (!historyData) {
        return res.status(404).json({ error: 'History file not found' });
      }

      const date = getSnapshotByFilename(filename)?.snapshotDate || extractHistoryDate(filename);
      
      const workbook = XLSX.utils.book_new();
      
      const summaryData = [
        ['HISTORICAL PRODUCTION REPORT SUMMARY'],
        ['Generated from backup:', date],
        [],
        ['Line', 'Model ID', 'Label/Week', 'Model', 'Date', 'Target', 'Output', 'QC Checking', 'Actual Defect', 'Defect Rate%']
      ];

      Object.keys(historyData.lines).forEach(lineName => {
        const line = historyData.lines[lineName];
        Object.keys(line.models).forEach(modelId => {
          const model = line.models[modelId];
          summaryData.push([
            lineName,
            modelId,
            model.labelWeek,
            model.model,
            model.date,
            model.target,
            model.outputDay,
            model.qcChecking,
            model.actualDefect,
            model.defectRatePercentage
          ]);
        });
      });

      const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

      Object.keys(historyData.lines).forEach(lineName => {
        const line = historyData.lines[lineName];
        
        Object.keys(line.models).forEach(modelId => {
          const model = line.models[modelId];
          
          const lineData = [
            [`PRODUCTION REPORT - ${lineName} - ${modelId}`],
            [],
            ['Label/Week', model.labelWeek],
            ['Model', model.model],
            ['Date', model.date],
            ['Target', model.target],
            ['Target per Hour', model.targetPerHour],
            ['Output/Hari', model.outputDay],
            ['QC Checking', model.qcChecking],
            ['Actual Defect', model.actualDefect],
            ['Defect Rate (%)', model.defectRatePercentage],
            [],
            ['HOURLY DATA'],
            ['Jam', 'Target Manual', 'Output', 'Selisih (Target - Output)', 'Defect', 'QC Checked', 'Defect Rate (%)']
          ];

          model.hourly_data.forEach(hour => {
            const defectRate = hour.qcChecked > 0 ? ((hour.defect / hour.qcChecked) * 100).toFixed(2) : '0.00';
            const selisih = hour.targetManual - hour.output;
            lineData.push([
              hour.hour, 
              hour.targetManual,
              hour.output, 
              selisih,
              hour.defect, 
              hour.qcChecked, 
              defectRate
            ]);
          });

          if (model.operators && model.operators.length > 0) {
            lineData.push([], ['OPERATOR DATA']);
            lineData.push(['No', 'Nama', 'Posisi', 'Target', 'Output', 'Defect', 'Efisiensi%', 'Status']);
            
            model.operators.forEach((operator, index) => {
              lineData.push([
                index + 1,
                operator.name,
                operator.position,
                operator.target,
                operator.output,
                operator.defect,
                operator.efficiency,
                operator.status === 'active' ? 'Aktif' : operator.status === 'break' ? 'Istirahat' : 'Off'
              ]);
            });
          }

          const lineSheet = XLSX.utils.aoa_to_sheet(lineData);
          XLSX.utils.book_append_sheet(workbook, lineSheet, `${lineName}_${modelId}`);
        });
      });

      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      const downloadFilename = `Historical_Production_Report_${date}.xlsx`;
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      
      res.send(excelBuffer);
    } catch (error) {
      logger.error('Gagal mengekspor histori', error);
      res.status(500).json({ error: 'Failed to export history data' });
    }
  });

  app.post('/api/backup/now', requireLogin, requireAdmin, async (req, res) => {
    try {
      const databaseFile = await createDatabaseBackup('manual');
      res.json({
        message: '✅ Backup database berhasil dibuat',
        filename: path.basename(databaseFile),
        size: fs.statSync(databaseFile).size,
        created: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Gagal membuat backup', error);
      res.status(500).json({ error: 'Failed to create backup' });
    }
  });

  app.post('/api/sync-dates', requireLogin, requireAdmin, async (req, res) => {
    const resetCount = checkAndResetDataForNewDay();
    const today = getToday();
    
    if (resetCount > 0) {
      res.json({ 
        message: `✅ Sinkronisasi tanggal selesai. ${resetCount} model direset ke tanggal ${today}`,
        resetCount: resetCount,
        today: today,
        status: 'success'
      });
    } else {
      res.json({ 
        message: `ℹ️ Tidak ada data yang perlu direset. Semua model sudah menggunakan tanggal ${today}`,
        resetCount: resetCount,
        today: today,
        status: 'no_changes'
      });
    }
  });
}

module.exports = { registerBackupRoutes, registerHistoryRoutes };
