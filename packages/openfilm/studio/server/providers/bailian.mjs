// @ts-check
/**
 * Alibaba Cloud Bailian (DashScope) with the person's own key: Qwen3-TTS voice-over, Qwen-Audio/Fun-ASR transcription
 * with word timings, Qwen-Image pictures, Wan 2.7 video and Qwen subtitle translation. REST API
 * (https://help.aliyun.com/zh/model-studio/), key as a bearer token. Beijing by default; DASHSCOPE_BASE_URL points it
 * at Singapore or a workspace domain. TTS has no word timings in this mode: subtitles spread the text over the line.
 */
import { extname } from 'node:path';
import {
  RATIO_SIZE, billedBy, call, clamp, dataUri, download, extOf, imageSize, landing, list, madePicture, mimeOf,
  modelOf, mp3Seconds, needed, noBalance, notes, number, round, serviceUrl, sleep, speechUpload, text,
  translatedLines, translationAsk, wavSeconds,
} from './common.mjs';

const NAME = 'Alibaba Cloud Bailian';
const DEFAULT_BASE = 'https://dashscope.aliyuncs.com';

const MODELS = {
  tts: [
    { id: 'qwen3-tts-flash', name: 'Qwen3 TTS Flash' },
    { id: 'qwen3-tts-instruct-flash', name: 'Qwen3 TTS Instruct Flash' },
  ],
  asr: [
    { id: 'qwen-audio-3.1-asr-flash', name: 'Qwen Audio 3.1 ASR Flash' },
    { id: 'qwen-audio-3.0-asr-flash', name: 'Qwen Audio 3.0 ASR Flash' },
    { id: 'fun-asr-flash-2026-06-15', name: 'Fun ASR Flash' },
  ],
  image: [
    { id: 'qwen-image-3.0', name: 'Qwen Image 3.0' },
    { id: 'qwen-image-3.0-pro', name: 'Qwen Image 3.0 Pro' },
    { id: 'qwen-image-2.1-pro', name: 'Qwen Image 2.1 Pro' },
  ],
  video: [
    { id: 'wan2.7-t2v', name: 'Wan 2.7 Text to Video' },
    { id: 'wan2.7-i2v', name: 'Wan 2.7 Image to Video' },
  ],
  translate: [
    { id: 'qwen3-max', name: 'Qwen3 Max' },
    { id: 'qwen-plus', name: 'Qwen Plus' },
    { id: 'qwen-turbo', name: 'Qwen Turbo' },
  ],
};

const VOICES = [
  { voiceId: 'Cherry', name: 'Cherry', language: 'zh', gender: 'f', description: 'Sunny female · Chinese and English' },
  { voiceId: 'Serena', name: 'Serena', language: 'zh', gender: 'f', description: 'Gentle female' },
  { voiceId: 'Ethan', name: 'Ethan', language: 'zh', gender: 'm', description: 'Sunny male · Chinese and English' },
  { voiceId: 'Chelsie', name: 'Chelsie', language: 'zh', gender: 'f', description: 'Anime female' },
  { voiceId: 'Dylan', name: 'Dylan', language: 'zh', gender: 'm', description: 'Beijing male' },
  { voiceId: 'Jada', name: 'Jada', language: 'zh', gender: 'f', description: 'Shanghai female' },
  { voiceId: 'Sunny', name: 'Sunny', language: 'zh', gender: 'f', description: 'Sichuan female' },
  { voiceId: 'Nofish', name: 'Nofish', language: 'zh', gender: 'm', description: 'Cantonese male' },
  { voiceId: 'Peter', name: 'Peter', language: 'en', gender: 'm', description: 'English male' },
  { voiceId: 'Eric', name: 'Eric', language: 'zh', gender: 'm', description: 'Tianjin male' },
  { voiceId: 'Rocky', name: 'Rocky', language: 'zh', gender: 'm', description: 'Cantonese male' },
  { voiceId: 'Kiki', name: 'Kiki', language: 'zh', gender: 'f', description: 'Cantonese female' },
];

const BASE = () => serviceUrl('BAILIAN', text(process.env.DASHSCOPE_BASE_URL) || DEFAULT_BASE);

function failed(/** @type {any} */ body) {
  const code = text(body?.code);
  const message = text(body?.message);
  if (/Arrearage|PrepaidBillOverdue|PostpaidBillOverdue/i.test(`${code} ${message}`)) throw noBalance(NAME);
  if (code) throw new Error(`${NAME} answered ${code}: ${message || 'no reason given'}`);
  return body;
}

export const polling = { ms: 15_000 };

/** @type {import('./contract.mjs').Provider} */
export default {
  id: 'bailian',
  name: NAME,
  env: 'DASHSCOPE_API_KEY',
  keysUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
  billingUrl: 'https://usercenter2.aliyun.com/finance/overview',
  verbs: ['voice', 'tts', 'asr', 'image', 'video', 'translate'],
  models: MODELS,
  speechFormat: 'mp3',
  async run(verb, args, ctx) {
    const base = BASE();
    const auth = { authorization: `Bearer ${ctx.key}` };
    const send = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) =>
      call(NAME, `${base}${path}`, { ...init, headers: { ...auth, ...init.headers } }, ctx);
    const post = async (/** @type {string} */ path, /** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = {}) =>
      failed(await (await send(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).json());
    const get = async (/** @type {string} */ path) => failed(await (await send(path)).json());

    if (verb === 'voice') {
      const prompt = text(args.prompt).toLowerCase();
      const language = text(args.language).toLowerCase();
      const gender = text(args.gender).toLowerCase().slice(0, 1);
      const limit = clamp(Math.round(number(args.limit) ?? 8), 1, VOICES.length);
      const match = (/** @type {{ voiceId: string, name: string, description: string }} */ v) =>
        [v.voiceId, v.name, v.description].some((field) => field.toLowerCase().includes(prompt));
      const found = VOICES.filter((v) => (!prompt || match(v))
        && (!language || (v.language ?? '').toLowerCase().startsWith(language))
        && (!gender || v.gender === gender));
      const said = prompt && !found.length ? ['no voice matched the prompt; these are others'] : [];
      return { files: [], index: [], receipt: { provider: 'bailian', voices: (found.length ? found : VOICES).slice(0, limit), ...notes(said) } };
    }

    if (verb === 'tts') {
      const voice = needed(args, 'voice');
      const said = needed(args, 'text');
      const model = modelOf(MODELS, 'tts', ctx);
      const body = await post('/api/v1/services/aigc/multimodal-generation/generation', { model, input: { text: said, voice } });
      const audio = body?.output?.audio;
      let bytes;
      let type = '';
      if (text(audio?.url)) {
        const got = await download(NAME, audio.url, ctx);
        bytes = got.bytes;
        type = got.type ?? '';
      } else if (text(audio?.data)) {
        bytes = new Uint8Array(Buffer.from(audio.data, 'base64'));
      } else {
        throw new Error(`${NAME} answered without audio.`);
      }
      const ext = extOf(type, 'wav');
      const path = landing('audio/vo', args.out, ext);
      const dur = wavSeconds(bytes) ?? (ext === 'mp3' ? mp3Seconds(bytes) : null);
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), text: said, voice, from: { mode: 'synth', text: said, voice, provider: 'bailian', model } }],
        receipt: { provider: 'bailian', model, src: path, dur, voice, notes: ['Bailian gives no word timings in this mode: subtitles spread the text over the line'] },
        cost: billedBy(NAME),
      };
    }

    if (verb === 'asr') {
      const src = needed(args, 'src');
      const upload = await speechUpload(src, ctx);
      if (upload.size > 100 * 1024 * 1024) throw new Error(`${NAME} transcribes files up to 100 MB and this speech is ${Math.ceil(upload.size / 1048576)} MB.`);
      const bytes = new Uint8Array(await upload.blob.arrayBuffer());
      const format = extname(upload.name).slice(1).toLowerCase() || 'mp3';
      const mime = format === 'mp3' ? 'audio/mp3' : mimeOf(upload.name);
      const model = modelOf(MODELS, 'asr', ctx);
      const body = await post('/api/v1/services/aigc/multimodal-generation/generation', {
        model,
        input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` } }] }] },
        parameters: { format },
      });
      const sentence = body?.output?.sentence;
      /** @type {{ token: string, start: number, end: number }[]} */
      const words = (Array.isArray(sentence?.words) ? sentence.words : []).flatMap((/** @type {any} */ w) => {
        const start = Number(w?.begin_time) / 1000;
        const end = Number(w?.end_time) / 1000;
        return text(w?.text) && Number.isFinite(start) && Number.isFinite(end) && end >= start ? [{ token: text(w.text), start, end }] : [];
      });
      const said = text(body?.output?.text) || text(sentence?.text) || words.map((w) => w.token).join(' ');
      const dur = number(body?.usage?.duration) ?? words.at(-1)?.end ?? null;
      return {
        files: [],
        index: [{ src, ...(dur !== null ? { dur: round(dur) } : {}), text: said, words, transcribed: true }],
        receipt: { provider: 'bailian', model, src, text: said, words: words.length, ...(dur !== null ? { dur: round(dur) } : {}) },
        cost: billedBy(NAME),
      };
    }

    if (verb === 'image') {
      const prompt = needed(args, 'prompt');
      const ratio = text(args.ratio) || '3:2';
      const size = RATIO_SIZE[ratio];
      if (!size) throw new Error(`--ratio is one of ${Object.keys(RATIO_SIZE).join(', ')}.`);
      const model = modelOf(MODELS, 'image', ctx);
      const said = [
        ...(args.transparent ? ['--transparent: Qwen-Image makes opaque pictures'] : []),
        ...(text(args.quality) === 'high' ? ['--quality high: Qwen-Image has one quality'] : []),
      ];
      const body = await post('/api/v1/services/aigc/multimodal-generation/generation', {
        model,
        input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
        parameters: { prompt_extend: true, n: 1, size: `${size.width}*${size.height}`, watermark: false },
      });
      const content = body?.output?.choices?.[0]?.message?.content;
      const url = (Array.isArray(content) ? content : []).map((/** @type {any} */ item) => text(item?.image)).find(Boolean);
      if (!url) throw new Error(`${NAME} answered without a picture.`);
      const got = await download(NAME, url, ctx);
      const path = landing('image', args.out, extOf(got.type, 'png'));
      return { ...madePicture({ path, bytes: got.bytes, prompt, provider: 'bailian', model, notes: said }), cost: billedBy(NAME) };
    }

    if (verb === 'translate') {
      const ask = translationAsk(args.lines, args.language);
      const model = modelOf(MODELS, 'translate', ctx);
      const body = await post('/compatible-mode/v1/chat/completions', {
        model,
        messages: [{ role: 'system', content: ask.system }, { role: 'user', content: ask.user }],
        response_format: { type: 'json_object' },
        temperature: 0,
      });
      const answer = text(body?.choices?.[0]?.message?.content);
      return {
        files: [], index: [],
        receipt: { provider: 'bailian', model, language: text(args.language), lines: translatedLines(answer, ask.count) },
        cost: billedBy(NAME),
      };
    }

    if (verb === 'video') {
      const prompt = needed(args, 'prompt');
      const first = text(args['first-frame']);
      const last = text(args['last-frame']);
      const refs = list(args['input-reference']);
      const said = [];
      if (refs.length) said.push('Wan 2.7 takes first and last frames, not reference pictures: the reference pictures were left out');
      if (last && !first) said.push('Wan 2.7 needs a first frame to use a last frame: the last frame was left out');
      const chosen = modelOf(MODELS, 'video', ctx);
      const framed = Boolean(first);
      const model = framed ? 'wan2.7-i2v' : 'wan2.7-t2v';
      if (chosen === 'wan2.7-i2v' && !framed) said.push('Wan 2.7 Image to Video needs a first frame: using Text to Video');
      if (chosen === 'wan2.7-t2v' && framed) said.push('A first frame was given: using Wan 2.7 Image to Video');
      const asked = number(args.duration) ?? 5;
      const seconds = clamp(Math.round(asked), 2, 15);
      if (seconds !== asked) said.push(`Wan 2.7 makes 2 to 15 second clips: ${seconds} s`);
      const requested = text(args['aspect-ratio']);
      let ratio = requested;
      if (framed && (!ratio || ratio === 'adaptive')) {
        const size = imageSize(await ctx.read(first));
        ratio = size && size.h > size.w ? '9:16' : '16:9';
      }
      const supported = ['16:9', '9:16', '1:1', '4:3', '3:4'];
      const tall = ['9:21', '2:3', '3:4', '9:16'].includes(ratio);
      const aspect = !ratio || ratio === 'adaptive' ? '16:9' : supported.includes(ratio) ? ratio : tall ? '9:16' : ['4:3', '1:1'].includes(ratio) ? ratio : '16:9';
      if (aspect !== ratio && ratio && ratio !== 'adaptive') said.push(`Wan 2.7 makes ${supported.join(', ')}: ${aspect}`);
      if (framed && requested && requested !== 'adaptive') said.push('Wan 2.7 Image to Video follows the first frame\'s shape: --aspect-ratio was left out');
      const media = [];
      if (first) media.push({ type: 'first_frame', url: await dataUri(first, ctx) });
      if (last && first) media.push({ type: 'last_frame', url: await dataUri(last, ctx) });
      const created = await post('/api/v1/services/aigc/video-generation/video-synthesis', {
        model,
        input: { prompt, ...(media.length ? { media } : {}) },
        parameters: {
          resolution: '1080P', duration: seconds, prompt_extend: true, watermark: false,
          ...(!framed && aspect ? { ratio: aspect } : {}),
        },
      }, { 'X-DashScope-Async': 'enable' });
      const taskId = text(created?.output?.task_id);
      if (!taskId) throw new Error(`${NAME} did not start the video.`);
      let task;
      for (;;) {
        await sleep(polling.ms, ctx.signal);
        task = await get(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
        const status = text(task?.output?.task_status);
        if (status === 'SUCCEEDED') break;
        if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
          throw new Error(`${NAME} could not make the clip: ${text(task?.output?.message) || text(task?.output?.code) || status}`);
        }
      }
      const url = text(task?.output?.video_url);
      if (!url) throw new Error(`${NAME} answered without a clip.`);
      const got = await download(NAME, url, ctx);
      const path = landing('video', args.out, 'mp4');
      const dur = number(task?.usage?.output_video_duration) ?? seconds;
      return {
        files: [{ path, bytes: got.bytes }],
        index: [{ src: path, kind: 'video', dur, hasAudio: true, from: {
          mode: 'generate', prompt, provider: 'bailian', model, resolution: '1080P', sec: seconds,
          ...(first ? { firstFrame: first } : {}), ...(last && first ? { lastFrame: last } : {}),
        } }],
        receipt: { provider: 'bailian', model, src: path, dur, hasAudio: true, resolution: '1080P', ...notes(said) },
        cost: billedBy(NAME),
      };
    }

    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
