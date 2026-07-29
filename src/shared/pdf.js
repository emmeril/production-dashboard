// Dependency-free fixed-layout PDF renderer for controlled operational reports.
const COLORS = {
  ink: '0.07 0.12 0.18', muted: '0.38 0.44 0.50', line: '0.84 0.87 0.89',
  paper: '0.97 0.98 0.98', white: '1 1 1', navy: '0.03 0.16 0.25',
  teal: '0.00 0.45 0.43', orange: '0.95 0.43 0.12', pale: '0.93 0.96 0.96'
};

function pdfText(value) {
  return String(value ?? '-').replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function shorten(value, width, fontSize = 7) {
  const text = String(value ?? '-');
  const max = Math.max(2, Math.floor((width - 9) / (fontSize * 0.52)));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 3))}...`;
}

function wrapLines(value, width, fontSize = 7) {
  const source = String(value ?? '-');
  const maxChars = Math.max(3, Math.floor((width - 9) / (fontSize * 0.52)));
  const lines = [];
  source.split(/\r?\n/).forEach(paragraph => {
    const words = paragraph.split(/\s+/); let line = '';
    words.forEach(wordValue => {
      let word = wordValue;
      if (!word) return;
      // Break unusually long tokens (PO/model identifiers) without dropping data.
      while (word.length > maxChars) {
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, maxChars)); word = word.slice(maxChars);
      }
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars) { if (line) lines.push(line); line = word; } else line = next;
    });
    if (line) lines.push(line);
  });
  if (!lines.length) lines.push('-');
  return lines;
}

function createPdfReport({ title, subtitle = '', meta = [], summary = [], columns = [], rows = [], footer = 'PRODUCTION DASHBOARD  |  CONTROLLED DOCUMENT' }) {
  const pageWidth = 842; const pageHeight = 595; const margin = 30;
  const pages = []; let current = []; let y = 0; let pageNumber = 1;
  const command = value => current.push(value);
  const rect = (x, yy, width, height, fill, stroke = '') => {
    command(`${fill} rg ${x} ${yy} ${width} ${height} re f`);
    if (stroke) command(`${stroke} RG 0.5 w ${x} ${yy} ${width} ${height} re S`);
  };
  const text = (x, yy, value, size = 8, bold = false, color = COLORS.ink) => command(`BT ${color} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${yy} Td (${pdfText(value)}) Tj ET`);
  const rule = (x1, yy, x2, color = COLORS.line, weight = 0.5) => command(`${color} RG ${weight} w ${x1} ${yy} m ${x2} ${yy} l S`);
  const printedAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const drawIdentity = continuation => {
    rect(0, 0, pageWidth, pageHeight, COLORS.paper);
    rect(0, pageHeight - 9, pageWidth, 9, COLORS.teal);
    rect(0, pageHeight - 9, 178, 9, COLORS.orange);
    text(margin, pageHeight - 36, 'PRODUCTION', 9, true, COLORS.teal);
    text(margin + 67, pageHeight - 36, 'CONTROL SYSTEM', 9, true, COLORS.navy);
    text(pageWidth - 178, pageHeight - 36, 'INTERNAL OPERATIONS', 7, true, COLORS.muted);
    if (continuation) {
      text(margin, pageHeight - 62, title, 13, true, COLORS.navy);
      text(pageWidth - 122, pageHeight - 61, `CONTINUED  /  ${String(pageNumber).padStart(2, '0')}`, 7, true, COLORS.teal);
      rule(margin, pageHeight - 72, pageWidth - margin, COLORS.line, 0.8);
      y = pageHeight - 94;
    }
  };
  const finishPage = () => {
    rule(margin, 35, pageWidth - margin, COLORS.line);
    text(margin, 21, footer, 6.5, true, COLORS.muted);
    text(pageWidth - 230, 21, `GENERATED ${printedAt} WIB`, 6.5, false, COLORS.muted);
    text(pageWidth - 52, 21, String(pageNumber).padStart(2, '0'), 7.5, true, COLORS.navy);
    pages.push(current.join('\n'));
  };
  const beginPage = continuation => { current = []; drawIdentity(continuation); };
  const newPage = () => { finishPage(); pageNumber += 1; beginPage(true); };

  beginPage(false);
  text(margin, 507, title, 22, true, COLORS.navy);
  text(margin, 486, subtitle.toUpperCase(), 7.5, true, COLORS.teal);
  rect(pageWidth - 192, 474, 162, 42, COLORS.navy);
  text(pageWidth - 179, 499, 'CONTROLLED REPORT', 8, true, COLORS.white);
  text(pageWidth - 179, 483, `DOC / ${String(pageNumber).padStart(2, '0')} / INTERNAL`, 6.5, false, '0.72 0.82 0.85');

  rect(margin, 428, pageWidth - margin * 2, 38, COLORS.white, COLORS.line);
  const metaWidth = (pageWidth - margin * 2) / Math.max(1, Math.min(meta.length, 4));
  meta.slice(0, 4).forEach(([label, value], index) => {
    const x = margin + index * metaWidth;
    if (index) command(`${COLORS.line} RG 0.5 w ${x} 435 m ${x} 459 l S`);
    text(x + 11, 452, String(label).toUpperCase(), 6.2, true, COLORS.muted);
    text(x + 11, 438, shorten(value, metaWidth - 18, 8), 8, true, COLORS.ink);
  });

  const cards = summary.slice(0, 5); const gap = 8; const cardWidth = (pageWidth - margin * 2 - gap * (cards.length - 1)) / Math.max(1, cards.length);
  cards.forEach(([label, value], index) => {
    const x = margin + index * (cardWidth + gap); const accent = index === 1 ? COLORS.teal : index === 4 ? COLORS.orange : COLORS.navy;
    rect(x, 374, cardWidth, 42, COLORS.white, COLORS.line); rect(x, 374, 4, 42, accent);
    text(x + 13, 399, String(label).toUpperCase(), 6.2, true, COLORS.muted);
    text(x + 13, 383, shorten(value, cardWidth - 20, 11), 11, true, accent);
  });
  text(margin, 348, 'OPERATIONAL DATA', 8, true, COLORS.navy);
  text(pageWidth - 175, 348, `${rows.length} RECORD${rows.length === 1 ? '' : 'S'}`, 7, true, COLORS.muted);
  rule(margin, 340, pageWidth - margin, COLORS.navy, 1.2); y = 320;

  const widths = columns.map(column => column.width);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) || 1;
  const scaled = widths.map(width => width * ((pageWidth - margin * 2) / totalWidth));
  const drawTableHeader = () => {
    rect(margin, y - 4, pageWidth - margin * 2, 24, COLORS.navy);
    let x = margin;
    columns.forEach((column, index) => { text(x + 5, y + 5, shorten(column.label, scaled[index], 6.5).toUpperCase(), 6.5, true, COLORS.white); x += scaled[index]; });
    y -= 12;
  };
  drawTableHeader(); y -= 19;
  if (!rows.length) {
    rect(margin, y - 24, pageWidth - margin * 2, 42, COLORS.white, COLORS.line);
    text(margin + 14, y - 5, 'Tidak ada data untuk filter laporan yang dipilih.', 8, false, COLORS.muted);
  }
  rows.forEach((row, rowIndex) => {
    const cellLines = columns.map((column, index) => wrapLines(row[column.key], scaled[index], 7));
    const lineCount = Math.max(...cellLines.map(lines => lines.length));
    const rowHeight = Math.max(23, 10 + lineCount * 9);
    if (y - rowHeight < 45) { newPage(); drawTableHeader(); y -= 19; }
    rect(margin, y - 13 - (rowHeight - 23), pageWidth - margin * 2, rowHeight, rowIndex % 2 ? COLORS.pale : COLORS.white);
    let x = margin;
    columns.forEach((column, index) => {
      const isNumeric = ['target', 'output', 'qc', 'qcChecked', 'good', 'defect', 'qtyOrder', 'qtyResult', 'modelResult', 'totalResult', 'no'].includes(column.key);
      const lines = cellLines[index];
      lines.forEach((value, lineIndex) => {
        const valueX = isNumeric ? x + scaled[index] - Math.min(scaled[index] - 5, value.length * 3.65 + 6) : x + 5;
        text(valueX, y - 3 - (lineIndex * 9), value, 7, column.key === 'line' || column.key === 'poMaterial', column.key === 'progress' ? COLORS.teal : COLORS.ink);
      });
      x += scaled[index];
    });
    rule(margin, y - 13 - (rowHeight - 23), pageWidth - margin, COLORS.line, 0.35); y -= rowHeight;
  });
  finishPage();

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [' + pages.map((_, index) => `${5 + index * 2} 0 R`).join(' ') + '] /Count ' + pages.length + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
  ];
  pages.forEach((content, index) => {
    const pageId = 5 + index * 2; const streamId = pageId + 1;
    objects[pageId - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`;
    objects[streamId - 1] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  });
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

module.exports = { createPdfReport };
