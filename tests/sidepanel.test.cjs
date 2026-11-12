'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSidepanel } = require('./helpers/sidepanel.cjs');

const firstId = 'BV1xx411c7mD';
const secondId = 'BV1xx411c7mE';
const caption = '1\r\n00:00:01,000 --> 00:00:02,000\r\n2026\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n臺灣軟體測試\r\n\r\n';

function videoInfo(bvid, overrides = {}) {
  const cid = bvid === secondId ? 102 : 101;
  return {
    success: true, bvid, aid: cid + 1000, cid,
    title: `測試影片 ${bvid}`, author: '測試作者',
    duration: 4, publishDate: 1735689600, tags: [], description: '',
    full_data: { owner: { mid: 42 }, pages: [{ page: 1, cid, duration: 4 }] },
    ...overrides,
  };
}

function subtitleHandlers(overrides = {}) {
  return {
    fetchBilibiliInfo: ({ videoId }) => videoInfo(videoId),
    fetchBilibiliSubtitleTracks: ({ cid, bvid, aid }) => ({
      success: true, cid, bvid, aid,
      subtitleTracks: [{ id: 'zh-track', lan: 'zh-Hant', lan_doc: '繁體中文', subtitle_url: 'https://aisubtitle.hdslb.com/fixture.json' }],
    }),
    fetchBilibiliSubtitleContent: () => ({
      success: true, subtitleText: caption,
      metadata: { lan: 'zh-Hant', lan_doc: '繁體中文' },
    }),
    ...overrides,
  };
}

async function addSingle(panel, bvid = firstId) {
  await panel.fill('#urlInput', `https://www.bilibili.com/video/${bvid}`);
  await panel.click('#generateUrlBtn');
  await panel.settle(() => panel.find('#totalVideoCount').textContent === '1', 'single video insertion');
}

async function fetchSubtitles(panel, count = 1) {
  await panel.click('#batchGetSubtitleBtn');
  await panel.settle(
    () => !panel.find('#batchGetSubtitleBtn').disabled && panel.find('#completedSubtitleCount').textContent === String(count),
    'subtitle track acquisition',
  );
}

test('complete sidepanel source initializes with persisted settings and no network', async (t) => {
  const panel = await createSidepanel({
    saved: { defaultExportMode: 'single', defaultExportFormat: 'srt', prependVideoInfoFields: [] },
  });
  t.after(() => panel.dispose());
  assert.match(panel.find('#videoTableBody').textContent, /暂无视频/);
  assert.equal(panel.find('#totalVideoCount').textContent, '0');
  assert.equal(panel.find('#formatSelectDropdown .selected').getAttribute('data-value'), 'srt');
  assert.equal(panel.find('#exportModeSelectDropdown .selected').getAttribute('data-value'), 'single');
  assert.equal(panel.find('#txtVideoInfoSelectTrigger .custom-select-selected-text').textContent, '不添加');
  assert.deepEqual(panel.calls.network, []);
  assert.deepEqual(panel.calls.logs.filter((entry) => entry.level === 'error'), []);
});

test('real buttons import, fetch tracks, copy original text and download numeric SRT cues', async (t) => {
  const panel = await createSidepanel({
    saved: { defaultExportMode: 'single', defaultExportFormat: 'srt', prependVideoInfoFields: [] },
    handlers: subtitleHandlers(),
  });
  t.after(() => panel.dispose());
  await addSingle(panel);
  await fetchSubtitles(panel);
  assert.equal(panel.calls.messages.filter((message) => message.action === 'fetchBilibiliSubtitleContent').length, 0);

  await panel.click('#videoTableBody .copy-row-btn');
  await panel.settle(() => panel.calls.clipboard.length === 1, 'clipboard write');

  await panel.click('#exportTableBtn');
  await panel.settle(() => panel.calls.downloads.length === 1 && !panel.find('#exportTableBtn').disabled, 'SRT download');
  const download = panel.calls.downloads[0];
  assert.match(download.filename, /\.srt$/);
  assert.equal(panel.calls.clipboard[0], '2026\n臺灣軟體測試');
  assert.equal(await download.blob.text(), '1\n00:00:01,000 --> 00:00:02,000\n2026\n\n2\n00:00:03,000 --> 00:00:04,000\n臺灣軟體測試');
  assert.equal(panel.calls.messages.filter((message) => message.action === 'fetchBilibiliSubtitleContent').length, 1, 'cached content is reused');
  assert.deepEqual(panel.calls.network, []);
  assert.deepEqual(panel.calls.tabs, []);
});

test('untrusted title and author remain text in the complete sidepanel import flow', async (t) => {
  const title = '<img src=x onerror="alert(1)">臺灣 & "資料"';
  const author = '</a><script>alert(2)</script>作者';
  const panel = await createSidepanel({
    handlers: subtitleHandlers({ fetchBilibiliInfo: ({ videoId }) => videoInfo(videoId, { title, author }) }),
  });
  t.after(() => panel.dispose());
  await addSingle(panel);
  const links = panel.document.querySelectorAll('#videoTableBody a');
  assert.equal(links[0].textContent, title);
  assert.equal(links[0].getAttribute('title'), title);
  assert.equal(links[1].textContent, author);
  assert.equal(panel.document.querySelector('#videoTableBody img'), null);
  assert.equal(panel.document.querySelector('#videoTableBody script'), null);
  assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
});

test('favorite pagination and duplicate handling feed the actual batch subtitle flow', async (t) => {
  const media = (bvid, id) => ({
    type: 2, bvid, id, title: `收藏影片 ${bvid}`, upper: { name: '收藏作者', mid: 42 },
    ugc: { first_cid: id }, pubtime: 1735689600,
  });
  const panel = await createSidepanel({
    handlers: subtitleHandlers({
      fetchFavoriteList: ({ page }) => ({
        success: true,
        data: page === 1
          ? { medias: [media(firstId, 101)], has_more: true }
          : { medias: [media(firstId, 101), media(secondId, 102)], has_more: false },
      }),
    }),
  });
  t.after(() => panel.dispose());
  await panel.click('#urlTypeDropdown .custom-select-option[data-value="favorite"]');
  await panel.fill('#urlInput', 'https://space.bilibili.com/42/favlist?fid=7');
  await panel.click('#getFavoriteBtn');
  await panel.settle(() => !panel.find('#getFavoriteBtn').disabled && panel.find('#totalVideoCount').textContent === '2', 'favorite pagination');
  assert.deepEqual(panel.calls.messages.filter((message) => message.action === 'fetchFavoriteList').map((message) => message.page), [1, 2]);
  await fetchSubtitles(panel, 2);
  assert.equal(panel.calls.messages.filter((message) => message.action === 'fetchBilibiliSubtitleTracks').length, 2);
  assert.equal(panel.document.querySelectorAll('#videoTableBody .copy-row-btn').length, 2);
  assert.deepEqual(panel.calls.network, []);
});

test('Cookie entry, visibility and clearing use local runtime messages without credential logs', async (t) => {
  const secret = 'SESSDATA=fixture-private-value;bili_jct=fixture-private-csrf';
  const panel = await createSidepanel();
  t.after(() => panel.dispose());
  await panel.fill('#bilibiliCookie', secret);
  assert.equal(panel.find('#bilibiliCookie').type, 'password');
  assert.equal(panel.storage.bilibiliCookie, secret);
  await panel.click('#cookieVisibilityBtn');
  assert.equal(panel.find('#bilibiliCookie').type, 'text');
  await panel.click('.cookie-clear-btn');
  assert.equal(panel.find('#bilibiliCookie').value, '');
  assert.equal(panel.find('#bilibiliCookie').type, 'password');
  assert.equal(panel.storage.bilibiliCookie, '');
  assert.deepEqual(panel.calls.messages.map((message) => message.action), ['setCookie', 'setCookie']);
  const logged = JSON.stringify(panel.calls.logs);
  assert.equal(logged.includes('fixture-private-value'), false);
  assert.equal(logged.includes('fixture-private-csrf'), false);
  assert.deepEqual(panel.calls.network, []);
  assert.deepEqual(panel.calls.tabs, []);
});

test('settings controls persist export mode, format and explicit metadata choices', async (t) => {
  const panel = await createSidepanel({ saved: { prependVideoInfoFields: [] } });
  t.after(() => panel.dispose());
  await panel.click('#settingsBtn');
  assert.equal(panel.find('#settingsModal').style.display, 'flex');
  await panel.click('#exportModeSelectDropdown .custom-select-option[data-value="single"]');
  await panel.click('#formatSelectDropdown .custom-select-option[data-value="md"]');
  await panel.click('#txtVideoInfoSelectDropdown .custom-multi-select-option[data-value="author"]');
  assert.equal(panel.storage.defaultExportMode, 'single');
  assert.equal(panel.storage.defaultExportFormat, 'md');
  assert.deepEqual(panel.storage.prependVideoInfoFields, ['author']);
  await panel.click('#settingsModalCloseBtn');
  assert.equal(panel.find('#settingsModal').style.display, 'none');

  const reopened = await createSidepanel({ saved: panel.storage });
  t.after(() => reopened.dispose());
  assert.equal(reopened.find('#formatSelectDropdown .selected').getAttribute('data-value'), 'md');
  assert.equal(reopened.find('#exportModeSelectDropdown .selected').getAttribute('data-value'), 'single');
  assert.equal(reopened.find('#txtVideoInfoSelectTrigger .custom-select-selected-text').textContent, '作者');
});

test('content retrieval failure remains visible and never creates a download', async (t) => {
  const panel = await createSidepanel({
    handlers: subtitleHandlers({ fetchBilibiliSubtitleContent: () => ({ success: false, message: 'fixture subtitle unavailable' }) }),
  });
  t.after(() => panel.dispose());
  await addSingle(panel);
  await fetchSubtitles(panel);
  await panel.click('#videoTableBody .copy-row-btn');
  await panel.settle(() => panel.find('#errorToast .error-toast-message').textContent.includes('fixture subtitle unavailable'), 'visible copy failure');
  assert.deepEqual(panel.calls.clipboard, []);
  assert.deepEqual(panel.calls.downloads, []);
});
