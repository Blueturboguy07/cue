// Extracts plain text from a document so it can be used as context (a résumé, a
// job description, meeting files). PDF and DOCX use their text layer; the rest
// are read as UTF-8. No OCR.
const fs = require('fs');
const path = require('path');

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yaml', '.yml']);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

async function parseDocumentFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.doc') throw new Error('Old .doc files are not supported. Save it as .docx or PDF and add it again.');
  if (ext !== '.pdf' && ext !== '.docx' && !TEXT_EXTENSIONS.has(ext)) {
    throw new Error('Unsupported file type: ' + (ext || '(none)') + '. Use a PDF, DOCX or text file.');
  }
  if (fs.statSync(filePath).size > MAX_FILE_BYTES) throw new Error('File is too large (limit 25 MB).');
  const buf = fs.readFileSync(filePath);
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const res = await pdfParse(buf);
    return (res.text || '').trim();
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const res = await mammoth.extractRawText({ buffer: buf });
    return (res.value || '').trim();
  }
  return buf.toString('utf8').trim();
}

module.exports = { parseDocumentFile };
