'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadFunctions } = require('./helpers/load-extension.cjs');

const quietConsole = { log() {}, warn() {}, error() {}, time() {}, timeEnd() {} };
const plain = (value) => JSON.parse(JSON.stringify(value));

function audio(seconds) {
  const samples = new Float32Array(seconds * 16000);
  return { sampleRate: 16000, numberOfChannels: 1, length: samples.length, getChannelData: () => samples };
}

const resultFunctions = [
  'transcribeAudioInFrontend', 'audioBufferTo16kHzMono', 'disposeTensorTree',
  'createTranscriptionReport', 'finalizeTranscriptionResult', 'formatTranscriptionElapsedTime',
  'buildTranscriptionResultFromChunks', 'resolveTranscriptionLanguage', 'inferTranscriptionLanguageFromText',
  'normalizeWhisperLanguageCode', 'getTranscriptionLanguageName', 'isChineseTranscriptionLanguage',
  'formatNonChineseChunksForTxt', 'convertToSRT', 'formatSRTTime', 'cleanTranscriptionText',
  'isLikelyGarbledText', 'shouldApplyChineseTextNormalization', 'traditionalToSimplified',
  'trimLeadingOverlapText', 'buildNormalizedTextIndexMap', 'findChunkTextOverlapLength',
  'getCommonPrefixLength', 'computeTextSimilarity', 'deduplicateChunksByTime',
];

function transcriptionContext({ failures = [], textOnly = false, untimed = [] } = {}) {
  const calls = [];
  let disposed = 0;
  const context = loadFunctions(resultFunctions, {
    globals: {
      console: quietConsole,
      initFrontendWhisper: async () => {},
      frontendWhisperProcessor: async () => ({ input_features: { dispose: () => { disposed++; } } }),
      // Stub only the inference boundary; the production chunk loop, aggregation,
      // coverage report, SRT formatting, and failure propagation run unchanged.
      transcribeSingleChunk: async (features, offset, progress, index) => {
        calls.push({ offset, index });
        if (failures.includes(index)) throw new Error(`inference failed ${index}`);
        const text = textOnly ? 'This statement really occurs twice.' : `Distinct speech segment ${index}.`;
        return { language: 'en', text, chunks: textOnly || untimed.includes(index) ? [] : [{ text, timestamp: [offset, offset + 1] }] };
      },
    },
  });
  return { context, calls, getDisposed: () => disposed };
}

test('complete inference processes the exact audio coverage and reports full success', async () => {
  const { context, calls, getDisposed } = transcriptionContext();
  const result = await context.transcribeAudioInFrontend(audio(60));
  assert.equal(result.transcriptionStatus, 'complete');
  assert.deepEqual(plain(result.transcriptionReport), {
    status: 'complete', totalChunks: 3, successfulChunks: 3, failedChunks: [], missingRanges: [], duration: 60,
  });
  assert.deepEqual(calls, [{ index: 1, offset: 0 }, { index: 2, offset: 24 }, { index: 3, offset: 48 }]);
  assert.equal(getDisposed(), 3);
  assert.match(result.srtContent, /00:00:48,000 --> 00:00:49,000/);
});

test('a failed middle chunk returns partial content and exact uncovered intervals', async () => {
  const { context, getDisposed } = transcriptionContext({ failures: [2] });
  const result = await context.transcribeAudioInFrontend(audio(60));
  assert.equal(result.transcriptionStatus, 'partial');
  assert.equal(result.transcriptionReport.successfulChunks, 2);
  assert.deepEqual(plain(result.transcriptionReport.failedChunks), [
    { index: 2, start: 24, end: 54, error: 'inference failed 2' },
  ]);
  assert.deepEqual(plain(result.transcriptionReport.missingRanges), [{ start: 30, end: 48 }]);
  assert.equal(getDisposed(), 3);
  assert.match(result.srtContent, /Distinct speech segment 1/);
  assert.match(result.srtContent, /Distinct speech segment 3/);
  assert.doesNotMatch(result.srtContent, /Distinct speech segment 2/);
});

test('all failed chunks reject with a failed report instead of returning an empty success', async () => {
  const { context } = transcriptionContext({ failures: [1, 2, 3] });
  await assert.rejects(context.transcribeAudioInFrontend(audio(60)), (error) => {
    assert.equal(error.code, 'TRANSCRIPTION_FAILED');
    assert.equal(error.transcriptionReport.status, 'failed');
    assert.equal(error.transcriptionReport.successfulChunks, 0);
    assert.equal(error.transcriptionReport.failedChunks.length, 3);
    assert.deepEqual(plain(error.transcriptionReport.missingRanges), [{ start: 0, end: 60 }]);
    return true;
  });
});

test('short audio uses the same failure contract and does not manufacture a success', async () => {
  const { context } = transcriptionContext({ failures: [1] });
  await assert.rejects(context.transcribeAudioInFrontend(audio(10)), (error) => {
    assert.equal(error.transcriptionReport.totalChunks, 1);
    assert.deepEqual(plain(error.transcriptionReport.missingRanges), [{ start: 0, end: 10 }]);
    return true;
  });
});

test('a fully covered tail is not needlessly processed as another failure-prone chunk', async () => {
  const { context, calls } = transcriptionContext();
  const result = await context.transcribeAudioInFrontend(audio(50));
  assert.equal(calls.length, 2);
  assert.equal(result.transcriptionReport.totalChunks, 2);
  assert.deepEqual(plain(result.transcriptionReport.missingRanges), []);
});

test('text following a missing chunk is not trimmed against nonadjacent earlier speech', async () => {
  const { context } = transcriptionContext({ failures: [2], textOnly: true });
  const result = await context.transcribeAudioInFrontend(audio(60));
  assert.equal(result.transcriptionStatus, 'partial');
  assert.equal(result.text.match(/This statement really occurs twice\./g).length, 2);
});

for (const untimed of [[1], [2], [1, 2]]) {
  test(`mixed or wholly untimed chunks retain both texts without inventing a timeline (${untimed.join(',')})`, async () => {
    const { context } = transcriptionContext({ untimed });
    const result = await context.transcribeAudioInFrontend(audio(50));
    assert.equal(result.transcriptionStatus, 'complete');
    assert.deepEqual(plain(result.chunks), []);
    assert.match(result.text, /Distinct speech segment 1/);
    assert.match(result.text, /Distinct speech segment 2/);
    assert.equal(result.srtContent, result.text);
    assert.doesNotMatch(result.srtContent, /-->/);
    assert.deepEqual(plain(result.transcriptionReport.untimedChunks), untimed.map((index) => ({
      index, start: (index - 1) * 24, end: Math.min((index - 1) * 24 + 30, 50),
    })));
  });
}

test('partial inference failure plus an untimed chunk preserves every successful text and both reports', async () => {
  const { context } = transcriptionContext({ failures: [2], untimed: [3] });
  const result = await context.transcribeAudioInFrontend(audio(60));
  assert.equal(result.transcriptionStatus, 'partial');
  assert.deepEqual(plain(result.chunks), []);
  assert.match(result.text, /Distinct speech segment 1/);
  assert.match(result.text, /Distinct speech segment 3/);
  assert.doesNotMatch(result.text, /Distinct speech segment 2/);
  assert.deepEqual(plain(result.transcriptionReport.missingRanges), [{ start: 30, end: 48 }]);
  assert.deepEqual(plain(result.transcriptionReport.untimedChunks), [{ index: 3, start: 48, end: 60 }]);
  assert.equal(result.transcriptionReport.failedChunks.length, 1);
});

const modelFunctions = [
  'getLocalWhisperModelConfigurations', 'checkLocalWhisperModel', 'preflightLocalWhisperModels',
  'isWebGPUAvailable', 'initFrontendWhisper',
];

function modelContext({ gpu = false, available = () => false, module = null } = {}) {
  const requests = [];
  const context = loadFunctions(modelFunctions, {
    globals: {
      console: quietConsole,
      navigator: gpu ? { gpu: { requestAdapter: async () => ({}) } } : {},
      chrome: { runtime: { getURL: (path) => `chrome-extension://test/${path}` } },
      fetch: async (url, options) => { requests.push({ url, options }); return { ok: available(url) }; },
      frontendWhisperModel: null,
      frontendWhisperProcessor: null,
      frontendWhisperTokenizer: null,
      frontendTransformersModule: module,
      currentModelName: '',
    },
  });
  return { context, requests };
}

test('missing ONNX weights produce actionable local-only preflight errors', async () => {
  const { context, requests } = modelContext();
  await assert.rejects(context.initFrontendWhisper(), (error) => {
    assert.equal(error.code, 'MISSING_LOCAL_WHISPER_MODEL');
    assert.match(error.message, /models\/whisper-small\/onnx\//);
    assert.match(error.message, /重新加载扩展/);
    assert.equal(error.missingModelFiles.length, 2);
    return true;
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url, options }) => url.startsWith('chrome-extension://test/') && options.method === 'HEAD'));
});

test('a missing GPU model still permits a fully installed CPU fallback', async () => {
  const { context } = modelContext({ gpu: true, available: (url) => url.includes('whisper-small/') });
  const models = await context.preflightLocalWhisperModels();
  assert.deepEqual(plain(models.map((model) => [model.name, model.device, model.dtype])), [['whisper-small', 'wasm', 'q8']]);
});

test('model initialization never enables remote model fetch and retries installed CPU after GPU failure', async () => {
  const loads = [];
  const module = {
    env: { backends: { onnx: { wasm: {} } } },
    AutoModelForSpeechSeq2Seq: { from_pretrained: async (path, options) => {
      loads.push({ kind: 'model', path, options });
      if (options.device === 'webgpu') throw new Error('GPU unsupported');
      return { generation_config: {} };
    } },
    AutoProcessor: { from_pretrained: async (path, options) => { loads.push({ kind: 'processor', path, options }); return {}; } },
    AutoTokenizer: { from_pretrained: async (path, options) => { loads.push({ kind: 'tokenizer', path, options }); return {}; } },
  };
  const { context } = modelContext({ gpu: true, available: () => true, module });
  await context.initFrontendWhisper();
  assert.equal(module.env.allowRemoteModels, false);
  assert.equal(module.env.allowLocalModels, true);
  assert.ok(loads.every(({ path, options }) => path.startsWith('chrome-extension://test/') && options.local_files_only === true));
  assert.deepEqual(loads.filter((load) => load.kind === 'model').map((load) => load.options.device), ['webgpu', 'wasm']);
  assert.equal(context.currentModelName, 'whisper-small');
});

const uiFunctions = [
  'runAudioTranscription', 'applyTranscriptionResult', 'upsertTranscribedSubtitleTrack',
  'isTranscribedSubtitleTrack', 'normalizeWhisperLanguageCode', 'getTranscriptionLanguageName',
  'isTranscribedSubtitle', 'isPartialTranscription', 'hasSubtitleTracks', 'hasSubtitleContent',
  'isSubtitleSuccessStatus', 'getSubtitleStatusDisplayText', 'shouldAttemptAudioTranscription',
  'getSubtitleContentForTrack', 'getSubtitleTrackId', 'getSubtitleTrackLanguageCode', 'getSubtitleLanguageName',
];

function uiContext({ initialize = async () => {}, transcribe = async () => {}, response = null, duration = 60 } = {}) {
  const messages = [];
  const errors = [];
  const successes = [];
  const loading = [];
  const video = { bvid: 'BV-test', cid: 1, title: 'Test video', duration, subtitleStatus: '无外挂字幕' };
  const context = loadFunctions(uiFunctions, {
    declarations: "const LOCAL_TRANSCRIPTION_TRACK_ID = 'local-transcription'; const LOCAL_TRANSCRIPTION_SOURCE = 'local-whisper'; const CHARGE_EXCLUSIVE_BLOCK_STATUS = '充电专属不可获取';",
    globals: {
      console: quietConsole, videoList: [video], skipTranscribeConfirmDialog: true,
      initFrontendWhisper: initialize,
      showError: (message) => errors.push(message), showSuccess: (message) => successes.push(message),
      showProgress() {}, setTranscribeProgressReminderVisible() {}, updateProgress() {},
      setTranscribeAudioButtonLoading: (value) => loading.push(value),
      getCurrentBilibiliVideoTab: async () => ({ id: 1, url: 'https://www.bilibili.com/' }),
      setTranscribeProgressContext() {}, clearTranscribeProgressContext() {}, updateTranscribeProgress() {}, updateVideoTable() {},
      refreshVideoExecutionInfo: async () => ({ success: true, info: {} }),
      ensureVideoCid: async () => true, isChargeExclusiveBlockedResponse: () => false,
      chrome: { runtime: { sendMessage: async (message) => {
        messages.push(message);
        return response || { success: true, stage: 'needs_frontend_processing', audioData: [1] };
      } } },
      decodeAudioInFrontend: async () => audio(duration), transcribeAudioInFrontend: transcribe,
      setTimeout: (callback) => { callback(); return 1; },
    },
  });
  return { context, messages, errors, successes, loading, video };
}

test('the actual button workflow stops before requesting audio when local models are missing', async () => {
  const models = modelContext();
  const ui = uiContext({ initialize: models.context.initFrontendWhisper });
  await ui.context.runAudioTranscription();
  assert.equal(ui.messages.length, 0);
  assert.equal(ui.successes.length, 0);
  assert.ok(ui.errors.some((message) => message.includes('本地转写模型未安装完整')));
  assert.deepEqual(ui.loading, [true, false]);
});

test('download routing always returns raw audio to the reviewed frontend even when AudioContext exists', async () => {
  let legacyContextReads = 0;
  const worker = {};
  Object.defineProperty(worker, 'AudioContext', { get() { legacyContextReads++; return function AudioContext() {}; } });
  const context = loadFunctions(['fetchAndDecodeAudio'], {
    filename: 'background.js',
    globals: {
      console: quietConsole, self: worker,
      downloadViaContentScript: async () => Uint8Array.from([1, 2, 3]).buffer,
      downloadAudioDirectly: async () => Uint8Array.from([4, 5, 6]).buffer,
    },
  });
  for (const tabId of [1, null]) {
    const result = await context.fetchAndDecodeAudio('https://example.invalid/audio', tabId, [], null, true);
    assert.equal(result.success, true);
    assert.equal(result.needsProcessing, true);
    assert.equal(result.audioBuffer, undefined);
    assert.equal(result.audioData.length, 3);
  }
  assert.equal(legacyContextReads, 0);
});

test('partial result warnings survive video state, subtitle track, cached content, and batch summary', async () => {
  const inference = transcriptionContext({ failures: [2] });
  const ui = uiContext({ transcribe: inference.context.transcribeAudioInFrontend });
  await ui.context.runAudioTranscription();
  assert.equal(ui.video.subtitleStatus, '部分转写');
  assert.equal(ui.video.transcriptionStatus, 'partial');
  assert.equal(ui.video.subtitleTracks[0].transcriptionReport.status, 'partial');
  const content = await ui.context.getSubtitleContentForTrack(ui.video, ui.video.subtitleTracks[0]);
  assert.equal(content.transcriptionReport.status, 'partial');
  assert.equal(content.metadata.transcriptionReport.status, 'partial');
  ui.video.subtitleTrackContents = {};
  const rebuiltContent = await ui.context.getSubtitleContentForTrack(ui.video, ui.video.subtitleTracks[0]);
  assert.equal(rebuiltContent.transcriptionReport.status, 'partial');
  assert.equal(ui.context.hasSubtitleContent(ui.video), true);
  assert.equal(ui.context.isSubtitleSuccessStatus(ui.video.subtitleStatus), false);
  assert.match(ui.context.getSubtitleStatusDisplayText(ui.video), /2\/3/);
  assert.ok(ui.errors.some((message) => /完整 0 个，部分 1 个，失败 0 个/.test(message)));
  assert.ok(!ui.successes.some((message) => message.startsWith('转写结束')));
  // A generic success label must not hide an existing partial transcription report.
  ui.video.subtitleStatus = '外挂字幕';
  assert.equal(ui.context.isPartialTranscription(ui.video), true);
  assert.match(ui.context.getSubtitleStatusDisplayText(ui.video), /部分转写/);
});

test('complete result is counted separately and all subtitle representations retain its report', async () => {
  const inference = transcriptionContext();
  const ui = uiContext({ transcribe: inference.context.transcribeAudioInFrontend });
  await ui.context.runAudioTranscription();
  assert.equal(ui.video.subtitleStatus, '转写字幕');
  assert.equal(ui.video.transcriptionStatus, 'complete');
  assert.equal(ui.video.subtitleTracks[0].transcriptionReport.successfulChunks, 3);
  assert.ok(ui.successes.some((message) => /转写结束：完整 1 个/.test(message)));
  assert.equal(ui.errors.length, 0);
});

test('a native subtitle track never inherits an unrelated local transcription warning', async () => {
  const ui = uiContext({ response: { success: true, subtitleText: 'Native subtitle text', metadata: { lan: 'en' } } });
  ui.video.transcriptionReport = { status: 'partial', totalChunks: 3, successfulChunks: 2 };
  const content = await ui.context.getSubtitleContentForTrack(ui.video, { trackId: 'native-en', lan: 'en', subtitle_url: 'https://example.invalid/subtitle' });
  assert.equal(content.transcriptionReport, undefined);
  assert.equal(content.metadata.transcriptionReport, undefined);
});

test('the actual button workflow records full inference failure and creates no transcript track', async () => {
  const inference = transcriptionContext({ failures: [1, 2, 3] });
  const ui = uiContext({ transcribe: inference.context.transcribeAudioInFrontend });
  await ui.context.runAudioTranscription();
  assert.equal(ui.video.transcriptionStatus, 'failed');
  assert.equal(ui.video.transcriptionReport.status, 'failed');
  assert.equal(ui.video.subtitleTracks, undefined);
  assert.ok(ui.errors.some((message) => /完整 0 个，部分 0 个，失败 1 个/.test(message)));
});

test('the 60 minute limit remains specific to local transcription and prevents audio download', async () => {
  const ui = uiContext({ duration: 3601 });
  await ui.context.runAudioTranscription();
  assert.equal(ui.messages.length, 0);
  assert.match(ui.video.subtitleStatus, /本地音频转写限60分钟，已有字幕仍可获取/);
});
