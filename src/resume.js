// Extracts plain text from a resume/job-description file (PDF or DOCX) so it can be
// dropped into the existing Settings textareas. No OCR — text layer only.
const fs = require('fs');
const path = require('path');

// Bounds on what gets pulled into the app: files beyond this size are refused
// outright, and extracted text beyond this length is truncated so a huge document
// can't balloon the settings file or jank the renderer's textarea.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;

function truncateText(text, max = MAX_TEXT_CHARS) {
  const value = text || '';
  if (value.length <= max) return value;
  return value.slice(0, max) + '\n\n[truncated: document text exceeds ' + max + ' characters]';
}

async function parseDocumentFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.pdf' && ext !== '.docx') {
    throw new Error('Unsupported file type: ' + (ext || '(none)') + '. Use a PDF or DOCX file.');
  }
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('File too large (' + Math.round(stat.size / 1024 / 1024) + ' MB); limit is ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + ' MB.');
  }
  const buf = await fs.promises.readFile(filePath);
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const res = await pdfParse(buf);
    return truncateText((res.text || '').trim());
  }
  const mammoth = require('mammoth');
  const res = await mammoth.extractRawText({ buffer: buf });
  return truncateText((res.value || '').trim());
}

module.exports = { parseDocumentFile, truncateText, MAX_FILE_BYTES, MAX_TEXT_CHARS };
