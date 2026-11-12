'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

// Test the actual browser functions without running a signed-in browser or
// rewriting their algorithms in the tests. Compilation identifies the end of
// a declaration even when its body contains nested functions or template text.
function extractFunction(source, name) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Invalid function name: ${name}`);
  const escapedName = name.replace(/[$]/g, '\\$&');
  const declaration = new RegExp(`^([\\t ]*)(?:async\\s+)?function\\s+${escapedName}\\s*\\(`, 'm').exec(source);
  if (!declaration) throw new Error(`Source function not found: ${name}`);
  const closing = new RegExp(`^${declaration[1]}\\};?[\\t ]*\\r?$`, 'gm');
  closing.lastIndex = declaration.index + declaration[0].length;
  let match;
  while ((match = closing.exec(source))) {
    const candidate = source.slice(declaration.index, closing.lastIndex);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error(`Cannot isolate complete source function: ${name}`);
}

function loadFunctions(names, { globals = {}, declarations = '', filename = 'script.js' } = {}) {
  const sourcePath = path.resolve(root, filename);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const selected = [...new Set(names)].map((name) => extractFunction(source, name)).join('\n');
  const context = vm.createContext({
    console, URL, URLSearchParams, TextEncoder, TextDecoder, Blob,
    setTimeout, clearTimeout, performance, ...globals,
  });
  new vm.Script(`${declarations}\n${selected}`, { filename: sourcePath }).runInContext(context);
  return context;
}

module.exports = { extractFunction, loadFunctions, root };
