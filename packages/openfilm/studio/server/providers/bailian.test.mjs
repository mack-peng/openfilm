import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import bailian, { polling } from './bailian.mjs';
import { wav } from './common.mjs';

const KEY = 'sk-test-0123456789';
/** A fake Bailian on 127.0.0.1: `reply` answers each request; `seen` keeps them. */
let server, base;
let reply = () => [404, {}];
const seen = [];

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const call = { method: req.method, url: new URL(req.url, 'http://x'), headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(call);
    const [status, body, type = 'application/json'] = await reply(call);
    res.writeHead(status, { 'content-type': type }).end(Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENFILM_BAILIAN_URL = base;
  polling.ms = 5;
});
after(() => server.close());
beforeEach(() => { seen.length = 0; reply = () => [404, {}]; });

const ctx = (files = {}, model, signal = new AbortController().signal) => ({ key: KEY, model, root: '/project', signal, say: () => {}, read: async (p) => files[p] });
const json = (call) => JSON.parse(call.body.toString('utf8'));
const png = (w, h) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return new Uint8Array(b);
};

test('voices: Qwen3-TTS voices by gender and language; the default is Cherry', async () => {
  const all = await bailian.run('voice', { limit: 2 }, ctx());
  assert.deepEqual(all.receipt.voices.map((v) => v.voiceId), ['Cherry', 'Serena']);
  const male = await bailian.run('voice', { gender: 'm', language: 'zh', limit: 3 }, ctx());
  assert.deepEqual(male.receipt.voices.map((v) => v.voiceId), ['Ethan', 'Dylan', 'Nofish']);
  const cantonese = await bailian.run('voice', { prompt: 'Cantonese' }, ctx());
  assert.deepEqual(cantonese.receipt.voices.map((v) => v.voiceId), ['Nofish', 'Rocky', 'Kiki']);
});

test('voice-over: Qwen3 TTS Flash, its audio downloaded, its length from the file', async () => {
  reply = (call) => {
    if (call.url.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
      return [200, { output: { audio: { url: `${base}/files/out.wav` } } }];
    }
    if (call.url.pathname === '/files/out.wav') return [200, wav(new Uint8Array(48000), 24000), 'audio/wav'];
    return [404, {}];
  };
  const result = await bailian.run('tts', { out: 'line', text: 'Hello.', voice: 'Cherry' }, ctx());
  const submit = seen.find((c) => c.method === 'POST');
  assert.equal(submit.url.pathname, '/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(submit.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(json(submit), { model: 'qwen3-tts-flash', input: { text: 'Hello.', voice: 'Cherry' } });
  assert.equal(result.files[0].path, 'assets/audio/vo/line.wav');
  assert.equal(result.index[0].dur, 1);
  assert.deepEqual(result.index[0].from, { mode: 'synth', text: 'Hello.', voice: 'Cherry', provider: 'bailian', model: 'qwen3-tts-flash' });
  assert.match(result.receipt.notes[0], /no word timings/);
});

test('a refusal in a 200 body is said; an arrearage is a balance error', async () => {
  reply = () => [200, { code: 'InvalidParameter', message: 'bad voice' }];
  await assert.rejects(bailian.run('tts', { out: 'x', text: 'y', voice: 'Cherry' }, ctx()), /InvalidParameter: bad voice/);
  reply = () => [200, { code: 'Arrearage', message: 'Access denied' }];
  await assert.rejects(bailian.run('tts', { out: 'x', text: 'y', voice: 'Cherry' }, ctx()), (e) => e.code === 'balance');
});

test('transcription: Qwen Audio 3.1 ASR Flash, the speech inline, word timings kept', async () => {
  reply = () => [200, {
    output: { text: 'Hello there.', sentence: { words: [{ text: 'Hello', begin_time: 0, end_time: 400 }, { text: 'there.', begin_time: 400, end_time: 900 }] } },
    usage: { duration: 0.9 },
  }];
  const mp3 = new Uint8Array(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]));
  const result = await bailian.run('asr', { src: 'assets/audio/talk.m4a' }, ctx({ 'assets/audio/talk.m4a': mp3 }));
  const submit = seen.at(-1);
  const body = json(submit);
  assert.equal(submit.url.pathname, '/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(body.model, 'qwen-audio-3.1-asr-flash');
  assert.equal(body.parameters.format, 'mp3');
  assert.match(body.input.messages[0].content[0].input_audio.data, /^data:audio\/mp3;base64,/);
  assert.deepEqual(result.index, [{
    src: 'assets/audio/talk.m4a', dur: 0.9, text: 'Hello there.', transcribed: true,
    words: [{ token: 'Hello', start: 0, end: 0.4 }, { token: 'there.', start: 0.4, end: 0.9 }],
  }]);
});

test('a picture: Qwen Image 3.0, the ratio as its size, the file downloaded', async () => {
  reply = (call) => {
    if (call.url.pathname === '/api/v1/services/aigc/multimodal-generation/generation') {
      return [200, { output: { choices: [{ message: { content: [{ image: `${base}/files/out.png` }] } }] } }];
    }
    if (call.url.pathname === '/files/out.png') return [200, png(1536, 864), 'image/png'];
    return [404, {}];
  };
  const result = await bailian.run('image', { out: 'hero', prompt: 'a brass key', ratio: '16:9', quality: 'high', transparent: true }, ctx());
  const submit = seen.find((c) => c.method === 'POST');
  assert.equal(submit.url.pathname, '/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(submit.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(json(submit), {
    model: 'qwen-image-3.0',
    input: { messages: [{ role: 'user', content: [{ text: 'a brass key' }] }] },
    parameters: { prompt_extend: true, n: 1, size: '1536*864', watermark: false },
  });
  assert.equal(result.files[0].path, 'assets/image/hero.png');
  assert.deepEqual([result.index[0].w, result.index[0].h], [1536, 864]);
  assert.equal(result.receipt.notes.length, 2);
});

test('translation: Qwen3 Max, JSON asked for, the lines back in order', async () => {
  reply = () => [200, { choices: [{ message: { content: '{"lines": ["Bonjour.", "Au revoir."]}' } }] }];
  const result = await bailian.run('translate', { lines: ['Hello.', 'Goodbye.'], language: 'fr' }, ctx());
  const submit = seen.at(-1);
  const body = json(submit);
  assert.equal(submit.url.pathname, '/compatible-mode/v1/chat/completions');
  assert.equal(body.model, 'qwen3-max');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.match(body.messages[0].content, /exactly 2 strings/);
  assert.deepEqual(result.receipt.lines, ['Bonjour.', 'Au revoir.']);
});

test('a text video: submitted asynchronously, asked after, downloaded; length and ratio brought within what Wan 2.7 makes', async () => {
  let asks = 0;
  reply = (call) => {
    if (call.method === 'POST' && call.url.pathname === '/api/v1/services/aigc/video-generation/video-synthesis') return [200, { output: { task_id: 't1' } }];
    if (call.url.pathname === '/api/v1/tasks/t1') {
      asks += 1;
      return [200, { output: { task_status: asks < 3 ? 'RUNNING' : 'SUCCEEDED', video_url: `${base}/files/out.mp4` }, usage: { output_video_duration: 15 } }];
    }
    if (call.url.pathname === '/files/out.mp4') return [200, Buffer.from('mp4'), 'video/mp4'];
    return [404, {}];
  };
  const result = await bailian.run('video', { out: 'shot', prompt: 'a slow push in', duration: 20, 'aspect-ratio': '2:3' }, ctx());
  const submit = seen.find((c) => c.method === 'POST');
  assert.equal(submit.headers.authorization, `Bearer ${KEY}`);
  assert.equal(submit.headers['x-dashscope-async'], 'enable');
  const body = json(submit);
  assert.equal(body.model, 'wan2.7-t2v');
  assert.deepEqual(body.parameters, { resolution: '1080P', duration: 15, prompt_extend: true, watermark: false, ratio: '9:16' });
  assert.equal(asks, 3);
  assert.equal(result.files[0].path, 'assets/video/shot.mp4');
  assert.equal(result.index[0].dur, 15);
  assert.equal(result.index[0].hasAudio, true);
  assert.match(result.receipt.notes.join(' '), /2 to 15 second/);
  assert.match(result.receipt.notes.join(' '), /9:16/);
});

test('an image video: Wan 2.7 Image to Video, the first and last frames inline, no ratio', async () => {
  reply = (call) => {
    if (call.method === 'POST' && call.url.pathname === '/api/v1/services/aigc/video-generation/video-synthesis') return [200, { output: { task_id: 't2' } }];
    if (call.url.pathname === '/api/v1/tasks/t2') return [200, { output: { task_status: 'SUCCEEDED', video_url: `${base}/files/out.mp4` }, usage: { output_video_duration: 5 } }];
    if (call.url.pathname === '/files/out.mp4') return [200, Buffer.from('mp4'), 'video/mp4'];
    return [404, {}];
  };
  const files = {
    'assets/image/a.png': png(16, 9), 'assets/image/b.png': png(16, 9), 'assets/image/r.png': png(16, 9),
  };
  const result = await bailian.run('video', {
    out: 'shot', prompt: 'morph', duration: 5, 'aspect-ratio': '16:9',
    'first-frame': 'assets/image/a.png', 'last-frame': 'assets/image/b.png', 'input-reference': ['assets/image/r.png'],
  }, ctx(files));
  const submit = seen.find((c) => c.method === 'POST');
  const body = json(submit);
  assert.equal(body.model, 'wan2.7-i2v');
  assert.deepEqual(body.input.media.map((m) => m.type), ['first_frame', 'last_frame']);
  assert.ok(body.input.media.every((m) => /^data:image\/png;base64,/.test(m.url)));
  assert.equal('ratio' in body.parameters, false);
  assert.equal(result.index[0].dur, 5);
  assert.match(result.receipt.notes.join(' '), /reference pictures/);
  assert.match(result.receipt.notes.join(' '), /Image to Video/);
  assert.match(result.receipt.notes.join(' '), /aspect-ratio/);
});

test('a failed video says why; music is not something this service does', async () => {
  reply = (call) => {
    if (call.method === 'POST') return [200, { output: { task_id: 't3' } }];
    if (call.url.pathname === '/api/v1/tasks/t3') return [200, { output: { task_status: 'FAILED', code: 'InvalidParameter', message: 'bad prompt' } }];
    return [404, {}];
  };
  await assert.rejects(bailian.run('video', { out: 'x', prompt: 'y' }, ctx()), /bad prompt/);
  await assert.rejects(bailian.run('music', { out: 'x', prompt: 'y' }, ctx()), /does not do music/);
});

test('a cancelled video run stops asking', async () => {
  let asks = 0;
  reply = (call) => {
    if (call.method === 'POST') return [200, { output: { task_id: 't4' } }];
    if (call.url.pathname === '/api/v1/tasks/t4') { asks += 1; return [200, { output: { task_status: 'RUNNING' } }]; }
    return [404, {}];
  };
  const stop = new AbortController();
  const run = bailian.run('video', { out: 'x', prompt: 'y' }, ctx({}, undefined, stop.signal));
  await new Promise((done) => setTimeout(done, 30));
  stop.abort();
  await assert.rejects(run);
  await new Promise((done) => setTimeout(done, 30));
  const at = asks;
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(asks, at);
});
