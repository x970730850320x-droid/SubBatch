'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseHTML } = require('linkedom');
const { loadFunctions } = require('./helpers/load-extension.cjs');

function renderVideo(video) {
  const { document } = parseHTML('<html><body><span id="videoCountInfo"></span><span id="totalVideoCount"></span><span id="completedSubtitleCount"></span><table><tbody id="videos"></tbody></table></body></html>');
  const context = loadFunctions(['escapeHtml', 'isPartialTranscription', 'updateVideoTable'], {
    globals: {
      document,
      videoTableBody: document.getElementById('videos'),
      videoList: [video],
      CHARGE_EXCLUSIVE_BLOCK_STATUS: '充电专属',
      closeSubtitleLanguageMenu() {},
      updateNoSubtitleBanner() {},
      hasSubtitleContent: () => true,
      isSubtitleSuccessStatus: (status) => status === '获取成功',
      getSubtitleStatusDisplayText: () => '外挂字幕',
      getTranscriptionStatusDisplayText: () => '部分完成',
      canCopyVideoSubtitle: () => true,
      getCopyButtonTitle: () => '复制视频脚本',
      formatDate: () => '2026-11-12',
      getSubtitleLanguageCellHtml: () => '<span>中文</span>',
      addTableButtonListeners() {},
    },
  });
  context.updateVideoTable();
  return document;
}

test('video titles and author names render as text, including quotes and markup', () => {
  const title = '\"><img id="injected" src="x" onerror="bad()"> & 原文';
  const author = '\'><svg id="author-injected" onload="bad()">測試';
  const document = renderVideo({ bvid: 'BV1UEzEB8Eiu', mid: '123', page: 2, title, author, subtitleStatus: '获取成功' });
  const links = [...document.querySelectorAll('a')];
  assert.equal(links[0].textContent, title);
  assert.equal(links[0].getAttribute('title'), title);
  assert.equal(links[1].textContent, author);
  assert.equal(links[1].getAttribute('title'), author);
  assert.equal(document.getElementById('injected'), null);
  assert.equal(document.getElementById('author-injected'), null);
  assert.equal(document.querySelector('[onerror], [onload]'), null);
  assert.equal(links[0].getAttribute('href'), 'https://www.bilibili.com/video/BV1UEzEB8Eiu?p=2');
  assert.equal(links[1].getAttribute('href'), 'https://space.bilibili.com/123');
  assert.match(links[0].getAttribute('rel'), /noopener/);
});

test('untrusted video IDs and page values cannot create attributes or external origins', () => {
  const document = renderVideo({ bvid: '\" onclick="bad()"', mid: '\"><img id="mid-injected">', page: '2" onclick="bad()', title: '標題', author: '作者', subtitleStatus: '获取成功' });
  const links = [...document.querySelectorAll('a')];
  assert.equal(new URL(links[0].getAttribute('href')).origin, 'https://www.bilibili.com');
  assert.equal(new URL(links[1].getAttribute('href')).origin, 'https://space.bilibili.com');
  assert.equal(new URL(links[0].getAttribute('href')).search, '');
  assert.equal(document.querySelector('[onclick]'), null);
  assert.equal(document.getElementById('mid-injected'), null);
});

test('API error status is displayed as text rather than injected HTML', () => {
  const status = '获取失败: <img id="status-injected" src="x" onerror="bad()">';
  const document = renderVideo({ bvid: 'BV1UEzEB8Eiu', title: '標題', author: '作者', subtitleStatus: status });
  assert.equal(document.querySelectorAll('td')[4].textContent, status);
  assert.equal(document.getElementById('status-injected'), null);
});

test('credential log summaries redact values without mutating the request headers', () => {
  const { getCookieLogSummary, sanitizeHeadersForLog } = loadFunctions(['getCookieLogSummary', 'sanitizeHeadersForLog'], { filename: 'background.js' });
  const fakeSecret = 'not-a-real-session';
  const cookie = `SESSDATA=${fakeSecret}; bili_jct=not-a-real-csrf; DedeUserID=123`;
  const headers = { Cookie: cookie, Authorization: `Bearer ${fakeSecret}`, 'Set-Cookie': cookie, Accept: 'application/json' };
  const sanitized = sanitizeHeadersForLog(headers);
  assert.equal(headers.Cookie, cookie);
  assert.equal(sanitized.Accept, 'application/json');
  assert.equal(JSON.stringify(sanitized).includes(fakeSecret), false);
  assert.equal(JSON.stringify(getCookieLogSummary(cookie)).includes(fakeSecret), false);
  assert.equal(getCookieLogSummary(cookie).hasSessData, true);
});
