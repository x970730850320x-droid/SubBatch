'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('../jszip.min.js');
const { loadFunctions, root } = require('./helpers/load-extension.cjs');

const source = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
const declarations = [
  source.match(/^  const EXPORT_FORMAT_VALUES = .*;$/m)[0],
  source.match(/^  const EXPORT_MODE_VALUES = .*;$/m)[0],
  source.match(/^  const TXT_VIDEO_INFO_FIELD_OPTIONS = \[[\s\S]*?^  \];/m)[0],
  source.match(/^  const DEFAULT_VIDEO_INFO_FIELDS = .*;$/m)[0],
].join('\n');

const parserFunctions = [
  'normalizeSubtitleNewlines', 'trimEmptyBoundaryLines', 'parseSubtitleTiming',
  'parseSubtitleCues', 'convertToSrtFormat', 'convertToTxtFormat',
];
const docxFunctions = ['normalizeSubtitleNewlines', 'escapeDocxXml', 'buildDocxDocument', 'getSubtitleMimeType'];
const warningFunctions = ['markPartialExportFileName', 'formatTranscriptionRangeTime', 'prependTranscriptionWarning'];
const parser = loadFunctions(parserFunctions);
const numericSubtitle = '1\n00:00:01.000 --> 00:00:02.000\n2026\n\n2\n00:00:03.000 --> 00:00:04.000\n測試字幕\n';

test('SRT retains numeric-only dialogue and numbers each cue once', () => {
  assert.equal(parser.convertToSrtFormat(numericSubtitle),
    '1\n00:00:01,000 --> 00:00:02,000\n2026\n\n2\n00:00:03,000 --> 00:00:04,000\n測試字幕');
  assert.equal(parser.convertToTxtFormat(numericSubtitle), '2026\n測試字幕');
});

test('BOM, CRLF, multiline dialogue and repeated real speech survive export', () => {
  const input = '\uFEFF7\r\n0:00:01.1 --> 0:00:02.25\r\n  繁體與 English 日本語\r\n123\r\n謝謝大家\r\n\r\n8\r\n00:00:03,000 --> 00:00:04,000\r\n謝謝大家\r\n123\r\n';
  assert.equal(parser.convertToTxtFormat(input, 'zh'), '  繁體與 English 日本語\n123\n謝謝大家\n謝謝大家\n123');
  assert.equal(parser.convertToSrtFormat(input),
    '1\n00:00:01,100 --> 00:00:02,250\n  繁體與 English 日本語\n123\n謝謝大家\n\n2\n00:00:03,000 --> 00:00:04,000\n謝謝大家\n123');
});

test('unnumbered adjacent cues do not consume the preceding numeric dialogue', () => {
  const input = '00:00:01.000 --> 00:00:02.000\n2026\n00:00:03.000 --> 00:00:04.000\n42\n第三行';
  assert.equal(parser.convertToTxtFormat(input), '2026\n42\n第三行');
  assert.equal(parser.parseSubtitleCues(input).cues.length, 2);
  assert.match(parser.convertToSrtFormat(input), /\n2026\n\n2\n/);
});

test('unstructured text, literal arrows, blank body lines and repeated sentences are retained', () => {
  const plain = '2026\n x --> y\n不要刪掉這一句。\n不要刪掉這一句。\n\n最後一段';
  assert.equal(parser.convertToTxtFormat(plain), plain);
  const timed = '00:00:01,000 --> 00:00:02,000\n x --> y\n\n第二段\n42\n';
  assert.equal(parser.convertToTxtFormat(timed), ' x --> y\n\n第二段\n42');
});

test('SRT refuses untimed text instead of silently dropping it or inventing timestamps', () => {
  assert.throws(() => parser.convertToSrtFormat('2026\n只有正文'), /TXT/);
  assert.throws(() => parser.convertToSrtFormat('前言\n\n' + numericSubtitle), /未对应时间轴/);
  assert.equal(parser.convertToTxtFormat('前言\n\n' + numericSubtitle), '前言\n2026\n測試字幕');
  assert.equal(parser.convertToSrtFormat(''), '');
});

test('ASR cleanup keeps traditional Chinese and mixed-language characters', () => {
  const ctx = loadFunctions(['cleanTranscriptionText', 'isLikelyGarbledText']);
  assert.equal(ctx.cleanTranscriptionText('<|0.00|> 強體結構 驗證錯誤 東京 English <|1.50|>', { language: 'zh' }),
    '強體結構 驗證錯誤 東京 English');
  assert.equal(ctx.cleanTranscriptionText('臺灣與繁體 體驗', { language: 'unknown' }), '臺灣與繁體 體驗');
});

test('new metadata defaults preserve existing explicit selections and old opt-outs', () => {
  const ctx = loadFunctions(['normalizePrependVideoInfoFields', 'resolvePrependVideoInfoFields', 'normalizeExportFormat'], { declarations });
  const result = (settings) => Array.from(ctx.resolvePrependVideoInfoFields(settings));
  assert.deepEqual(result({}), ['title', 'link', 'author', 'publishDate']);
  assert.deepEqual(result({ prependVideoInfoFields: [] }), []);
  assert.deepEqual(result({ prependVideoInfoFields: ['description', 'link'] }), ['link', 'description']);
  assert.deepEqual(result({ prependVideoInfo: false }), []);
  assert.deepEqual(result({ prependVideoInfo: true }), ['title', 'link']);
  assert.equal(ctx.normalizeExportFormat('doc'), 'docx');
  assert.equal(ctx.normalizeExportFormat('docx'), 'docx');
  assert.equal(ctx.normalizeExportFormat('unexpected'), 'txt');
});

test('DOCX is an OOXML ZIP with correct content types, relationships and escaped original text', async () => {
  const ctx = loadFunctions(docxFunctions, { globals: { JSZip } });
  const bytes = await ctx.buildDocxDocument('繁體 & <標題> "引號"\n2026\n  第二行\t欄位');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  const relationships = await zip.file('_rels/.rels').async('string');
  const document = await zip.file('word/document.xml').async('string');
  assert.match(contentTypes, /PartName="\/word\/document.xml" ContentType="application\/vnd.openxmlformats-officedocument.wordprocessingml.document.main\+xml"/);
  assert.match(relationships, /Target="word\/document.xml"/);
  assert.match(document, /繁體 &amp; &lt;標題&gt; &quot;引號&quot;/);
  assert.match(document, /<w:t xml:space="preserve">2026<\/w:t>/);
  assert.match(document, /<w:t xml:space="preserve">  第二行<\/w:t>/);
  assert.match(document, /<w:tab\/>/);
  assert.equal(ctx.getSubtitleMimeType('字幕.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('DOCX replaces invalid XML scalars while preserving traditional Chinese, emoji and legal whitespace', async () => {
  const ctx = loadFunctions(docxFunctions, { globals: { JSZip } });
  const legal = '\t\n\r繁體 🙂 𠀀 \uD7FF\uE000\uFFFD\u0085';
  const invalid = '\u0000\u0008\u000B\u000C\u001F\uFFFE\uFFFF\uD800|\uDC00';
  const replaced = '\uFFFD'.repeat(8) + '|\uFFFD';
  assert.equal(ctx.escapeDocxXml(legal), legal);
  assert.equal(ctx.escapeDocxXml(invalid), replaced);

  const bytes = await ctx.buildDocxDocument('繁體 🙂 𠀀\t' + invalid + '\n下一行');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('<w:t xml:space="preserve">繁體 🙂 𠀀</w:t>'));
  assert.ok(xml.includes(`<w:t xml:space="preserve">${replaced}</w:t>`));
  assert.ok(xml.includes('<w:t xml:space="preserve">下一行</w:t>'));
  assert.match(xml, /<w:tab\/>/);
});

const partialReport = {
  status: 'partial', totalChunks: 3, successfulChunks: 2, duration: 90,
  failedChunks: [{ index: 2, start: 25, end: 65, error: 'inference failed' }],
  missingRanges: [{ start: 30, end: 60 }],
};

test('partial warnings use missing coverage, independent of optional source metadata', () => {
  const ctx = loadFunctions(warningFunctions);
  const warned = ctx.prependTranscriptionWarning('正文', partialReport);
  assert.match(warned, /成功 2\/3 段，内容不完整/);
  assert.match(warned, /00:00:30–00:01:00/);
  assert.doesNotMatch(warned, /00:00:25/);
  assert.match(ctx.prependTranscriptionWarning('正文', { ...partialReport, missingRanges: [{ start: 30.25, end: 60.75 }] }),
    /00:00:30.250–00:01:00.750/);
  assert.equal(ctx.markPartialExportFileName('字幕.srt', partialReport), '字幕_partial.srt');
  assert.equal(ctx.prependTranscriptionWarning('正文', { status: 'complete' }), '正文');
  assert.equal(ctx.markPartialExportFileName('字幕.srt', { status: 'complete' }), '字幕.srt');
});

function exportHarness({ report, format, mode, track = null }) {
  const downloads = [];
  const errors = [];
  const video = { title: '測試字幕', bvid: 'BVTEST', page: 2, subtitleText: numericSubtitle, transcriptionReport: report };
  const ctx = loadFunctions([
    ...parserFunctions, ...docxFunctions, ...warningFunctions, 'executeExport', 'normalizeExportMode', 'buildExportVideoUrl',
  ], {
    declarations,
    globals: {
      JSZip, document: { getElementById: () => null },
      showProgress() {}, updateProgress() {}, showSuccess() {}, resetExportButton() {},
      showError(message) { errors.push(message); },
      buildSubtitleExportTasks: () => [{ video, track, fileName: `字幕.${format}` }],
      getSubtitleContentForTrack: async () => ({ subtitleText: numericSubtitle, transcriptionReport: report }),
      getSubtitleTrackLanguageCode: () => 'zh',
      ensureVideoExportMetadata: async () => {},
      prependVideoInfoText: (text) => text,
      triggerSubtitleFileDownload: async (fileName, content) => { downloads.push({ fileName, content }); },
      buildZipDownloadFileName: () => 'subtitles.zip',
      wait: async () => {}, setTimeout: (fn) => { fn(); return 0; },
    },
  });
  return { ctx, video, downloads, errors, run: () => ctx.executeExport([video], format, mode) };
}

test('actual SRT export creates a standard subtitle plus a partial-coverage sidecar', async () => {
  const harness = exportHarness({ report: partialReport, format: 'srt', mode: 'single', track: { source: 'local-transcription' } });
  await harness.run();
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.downloads.map((entry) => entry.fileName), ['字幕_partial.srt', '字幕_partial.srt.transcription.json']);
  assert.match(harness.downloads[0].content, /\n2026\n\n2\n/);
  assert.doesNotMatch(harness.downloads[0].content, /部分转写/);
  const report = JSON.parse(harness.downloads[1].content);
  assert.equal(report.sourceUrl, 'https://www.bilibili.com/video/BVTEST?p=2');
  assert.deepEqual(report.transcriptionReport, partialReport);
});

test('actual DOCX export embeds a real document with partial warning inside a batch ZIP', async () => {
  const harness = exportHarness({ report: partialReport, format: 'docx', mode: 'zip' });
  await harness.run();
  assert.deepEqual(harness.errors, []);
  assert.equal(harness.downloads.length, 1);
  const outerBytes = new Uint8Array(await harness.downloads[0].content.arrayBuffer());
  const outerZip = await JSZip.loadAsync(outerBytes, { checkCRC32: true });
  const docxBytes = await outerZip.file('字幕_partial.docx').async('uint8array');
  const docxZip = await JSZip.loadAsync(docxBytes, { checkCRC32: true });
  const xml = await docxZip.file('word/document.xml').async('string');
  assert.match(xml, /部分转写/);
  assert.match(xml, /00:00:30–00:01:00/);
  assert.match(xml, /2026/);
  assert.match(xml, /測試字幕/);
});

test('actual TXT and MD export preserve original text and disclose partial transcription', async () => {
  for (const format of ['txt', 'md']) {
    const harness = exportHarness({ report: partialReport, format, mode: 'single' });
    await harness.run();
    assert.deepEqual(harness.errors, []);
    assert.equal(harness.downloads[0].fileName, `字幕_partial.${format}`);
    assert.match(harness.downloads[0].content, /部分转写/);
    assert.match(harness.downloads[0].content, /2026\n測試字幕$/);
  }
});

test('actual copy action preserves numeric and traditional dialogue and discloses partial content', async () => {
  let click;
  const copied = [];
  const errors = [];
  const button = { addEventListener: (event, handler) => { click = handler; }, getAttribute: () => '0' };
  const track = { source: 'local-transcription' };
  const ctx = loadFunctions([...parserFunctions, ...warningFunctions, 'addTableButtonListeners'], {
    globals: {
      videoList: [{ subtitleText: 'stale data' }],
      document: { querySelectorAll: (selector) => selector === '.copy-row-btn' ? [button] : [] },
      navigator: { clipboard: { writeText: async (text) => { copied.push(text); } } },
      hasSubtitleContent: () => true, isTranscribedSubtitle: () => false, hasSubtitleTracks: () => true,
      getSelectedSubtitleTracks: () => [track], getSubtitleTrackLanguageCode: () => 'zh',
      getSubtitleContentForTrack: async () => ({ subtitleText: numericSubtitle, transcriptionReport: partialReport }),
      ensureVideoExportMetadata: async () => {}, prependVideoInfoText: (text) => text,
      showSuccess() {}, showError: (message) => errors.push(message),
    },
  });
  ctx.addTableButtonListeners();
  await click.call(button);
  assert.deepEqual(errors, []);
  assert.equal(copied.length, 1);
  assert.match(copied[0], /部分转写/);
  assert.match(copied[0], /2026\n測試字幕$/);
});
