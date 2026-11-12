'use strict';

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('../jszip.min.js');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const zip = new JSZip();
const excluded = new Set(['.DS_Store', '.gitkeep']);

function add(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      if (!excluded.has(entry)) add(`${relativePath}/${entry}`);
    }
    return;
  }
  // Explicit source allowlist below excludes account state, tests, Git metadata,
  // node_modules and local notes. Models, when intentionally supplied, stay local.
  zip.file(relativePath, fs.readFileSync(absolutePath), { date: new Date('2026-01-01T00:00:00Z') });
}

async function main() {
  for (const entry of ['manifest.json', 'background.js', 'script.js', 'sidepanel.html', 'offscreen.html', 'jszip.min.js', 'LICENSE', 'README.md', 'MODEL_SETUP.md', 'images', 'libs', 'models']) add(entry);
  const output = path.join(root, 'dist', `SubBatch-${manifest.version_name || manifest.version}.zip`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(output, bytes);
  const modelWeights = Object.keys(zip.files).filter((name) => name.endsWith('.onnx'));
  console.log(`${path.relative(root, output)} (${bytes.length} bytes; ${modelWeights.length} ONNX weight files)`);
  if (modelWeights.length === 0) console.log('Existing subtitles work without models. Local transcription requires separately supplied ONNX models; the UI checks before audio download.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
