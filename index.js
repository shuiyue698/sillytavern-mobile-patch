const EXTENSION_ID = 'tauritavern-gpt-image-relay';
const ROOT_ID = 'tt-gpt-image-relay';
const REFERENCE_STORAGE_KEY = `${EXTENSION_ID}:reference-image`;
const MODEL_CACHE_KEY = `${EXTENSION_ID}:models`;

const DEFAULT_SETTINGS = {
    apiUrl: '',
    apiKey: '',
    imageModel: '',
    analysisModel: 'gpt-5.6-luna',
    resolution: '1920x1080',
    style: '',
    sourceMode: 'card_text',
    manualPrompt: '',
    protagonist: '',
    sceneCast: '',
    referenceCaption: '',
    autoAnalyze: true,
};

const RESOLUTIONS = [
    ['1920x1080', '1920x1080（16:9，1080p）'],
    ['1536x1024', '1536x1024（3:2）'],
    ['1792x1024', '1792x1024（16:9）'],
    ['1280x720', '1280x720（16:9）'],
    ['1024x1024', '1024x1024（1:1）'],
    ['1024x1536', '1024x1536（2:3）'],
];

const STYLES = [
    ['', '不指定风格'],
    ['anime illustration, clean line art', '动漫风'],
    ['二次元 digital illustration, expressive anime character design', '二次元风'],
    ['cel shading, clean cel-painted colors, crisp highlights', '赛璐璐风'],
    ['realistic photography, natural skin texture', '写实摄影'],
    ['cinematic concept art, dramatic but readable lighting', '电影概念艺术'],
    ['watercolor illustration, visible paper texture', '水彩插画'],
];

let hostContext = null;
let settings = null;
let modelIds = [];
let lastModelError = null;
let activationPromise = null;
let mountObserver = null;
let generationBusy = false;

function getContext() {
    return hostContext || globalThis.SillyTavern?.getContext?.() || null;
}

function notify(kind, message) {
    const fn = globalThis.toastr?.[kind];
    if (typeof fn === 'function') {
        fn.call(globalThis.toastr, message, 'GPT 生图');
    } else {
        console[kind === 'error' ? 'error' : 'log'](`[${EXTENSION_ID}] ${message}`);
    }
}

function saveSettings() {
    try {
        getContext()?.saveSettingsDebounced?.();
    } catch (error) {
        console.warn(`[${EXTENSION_ID}] settings could not be saved`, error);
    }
}

function loadSettings() {
    const context = getContext();
    if (!context) return;
    const allSettings = context.extensionSettings || (context.extensionSettings = {});
    const saved = allSettings[EXTENSION_ID];
    settings = {
        ...DEFAULT_SETTINGS,
        ...(saved && typeof saved === 'object' ? saved : {}),
    };
    allSettings[EXTENSION_ID] = settings;
}

function waitForHostReady() {
    const ready = globalThis.__TAURITAVERN__?.ready || globalThis.__TAURITAVERN_MAIN_READY__;
    return ready && typeof ready.then === 'function' ? ready : Promise.resolve();
}

function getRoot() {
    return document.getElementById(ROOT_ID);
}

function getElement(id) {
    return getRoot()?.querySelector(`#${id}`) || document.getElementById(id);
}

function setStatus(message, kind = '') {
    const node = getElement('tt-gpt-status');
    if (!node) return;
    node.textContent = message || '';
    node.dataset.kind = kind;
}

function setApiStatus(message, kind = '') {
    const node = getElement('tt-gpt-api-status');
    if (!node) return;
    node.textContent = message || '';
    node.dataset.kind = kind;
}

function getReferenceImage() {
    try {
        return localStorage.getItem(REFERENCE_STORAGE_KEY) || '';
    } catch {
        return '';
    }
}

function setReferenceImage(dataUrl) {
    try {
        if (dataUrl) localStorage.setItem(REFERENCE_STORAGE_KEY, dataUrl);
        else localStorage.removeItem(REFERENCE_STORAGE_KEY);
    } catch (error) {
        console.warn(`[${EXTENSION_ID}] reference image storage failed`, error);
    }
}

function normalizeApiUrl(value) {
    let url = String(value || '').trim().replace(/\/+$/, '');
    url = url.replace(/\/(?:images\/generations|chat\/completions|models)$/i, '');
    return url;
}

function endpointCandidates(path) {
    const base = normalizeApiUrl(settings?.apiUrl);
    if (!base) return [];
    const hasVersion = /\/v\d+(?:\.\d+)?$/i.test(base);
    const candidates = hasVersion
        ? [`${base}/${path}`]
        : [`${base}/v1/${path}`, `${base}/${path}`];
    return [...new Set(candidates)];
}

function apiHeaders(json = false) {
    const headers = { Accept: 'application/json' };
    if (json) headers['Content-Type'] = 'application/json';
    const key = String(settings?.apiKey || '').trim();
    if (key) headers.Authorization = /^Bearer\s+/i.test(key) ? key : `Bearer ${key}`;
    return headers;
}

async function requestApi(path, options = {}) {
    const candidates = endpointCandidates(path);
    if (!candidates.length) throw new Error('请先填写生图 API 地址。');
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
        const url = candidates[index];
        try {
            const response = await fetch(url, {
                ...options,
                headers: { ...apiHeaders(Boolean(options.body)), ...(options.headers || {}) },
            });
            if (response.ok) return response;
            const body = await response.text();
            const error = new Error(body || `HTTP ${response.status}`);
            error.status = response.status;
            lastError = error;
            if (response.status !== 404 || index === candidates.length - 1) throw error;
        } catch (error) {
            lastError = error;
            if (index === candidates.length - 1) throw error;
        }
    }
    throw lastError || new Error('中转站请求失败。');
}

function extractModelIds(payload) {
    // Relays may return data[], models[], data.models[], or result.data[].
    const values = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
            ? payload.models
            : Array.isArray(payload?.data?.models)
                ? payload.data.models
                : Array.isArray(payload?.result?.data)
                    ? payload.result.data
                    : [];
    return values
        .map(item => typeof item === 'string' ? item : item?.id || item?.name || item?.model)
        .map(item => String(item || '').trim())
        .filter(Boolean)
        .filter((item, index, array) => array.indexOf(item) === index)
        .sort((a, b) => a.localeCompare(b));
}

async function requestHostProxy(path, body) {
    // Use an optional same-origin relay to avoid mobile WebView CORS failures.
    try {
        const response = await fetch(path, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (response.status === 404 || response.status === 405) return null;
        const contentType = response.headers?.get?.('content-type') || '';
        if (/text\/html/i.test(contentType)) return null;
        if (!response.ok) {
            const error = new Error((await response.text()) || `HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response;
    } catch (error) {
        if (error?.status === 404 || error?.status === 405) return null;
        if (error instanceof TypeError && /failed to fetch/i.test(error.message || '')) return null;
        throw error;
    }
}

function chooseDefaultImageModel(ids) {
    const preferred = ids.find(id => /gpt-image|dall-e|image|flux|sdxl|stable-diffusion/i.test(id));
    return preferred || ids[0] || '';
}

function chooseDefaultAnalysisModel(ids) {
    const saved = String(settings?.analysisModel || '').trim();
    if (saved) return saved;
    return ids.find(id => !/gpt-image|dall-e|image|embedding|audio|tts|whisper/i.test(id)) || ids[0] || 'gpt-5.6-luna';
}

function fillModelSelects() {
    const imageSelect = getElement('tt-gpt-image-model-select');
    const analysisSelect = getElement('tt-gpt-analysis-model-select');
    const makeOptions = (select, selected, emptyLabel) => {
        if (!select) return;
        const values = [...modelIds];
        if (selected && !values.includes(selected)) values.unshift(selected);
        select.replaceChildren();
        if (!values.length) {
            select.add(new Option(emptyLabel, ''));
        } else {
            for (const id of values) select.add(new Option(id, id));
        }
        if (selected) select.value = selected;
    };
    makeOptions(imageSelect, settings?.imageModel || chooseDefaultImageModel(modelIds), '先点“刷新模型”或手动填写模型');
    makeOptions(analysisSelect, settings?.analysisModel || chooseDefaultAnalysisModel(modelIds), '先点“刷新模型”或手动填写模型');
}

async function refreshModels({ silent = false } = {}) {
    lastModelError = null;
    try {
        let response = await requestHostProxy('/api/openai/test-image-connection', {
            api_url: normalizeApiUrl(settings?.apiUrl),
            api_key: String(settings?.apiKey || '').trim(),
        });
        let payload;
        if (response) {
            payload = await response.json();
            modelIds = extractModelIds(payload?.models ? { data: payload.models } : payload);
        } else {
            response = await requestApi('models', { method: 'GET' });
            payload = await response.json();
            modelIds = extractModelIds(payload);
        }
        try { localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(modelIds)); } catch { /* best effort */ }
        if (!settings.imageModel) settings.imageModel = chooseDefaultImageModel(modelIds);
        if (!settings.analysisModel) settings.analysisModel = chooseDefaultAnalysisModel(modelIds);
        fillModelSelects();
        saveSettings();
        setApiStatus(`${modelIds.length} 个模型可用`, 'success');
        if (!silent) notify('success', `已读取 ${modelIds.length} 个模型，可以在下拉框选择。`);
        return modelIds;
    } catch (error) {
        lastModelError = error;
        if (!silent) {
            setApiStatus(`连接失败：${error.message || error}`, 'error');
            notify('error', `读取模型失败：${error.message || error}`);
        }
        return [];
    }
}

function loadCachedModels() {
    try {
        const cached = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || '[]');
        if (Array.isArray(cached)) modelIds = cached.filter(item => typeof item === 'string');
    } catch { /* ignore invalid cache */ }
}

async function testConnection() {
    const button = getElement('tt-gpt-api-test');
    if (button) button.disabled = true;
    setApiStatus('正在连接…', 'pending');
    try {
        const ids = await refreshModels({ silent: true });
        if (lastModelError) throw lastModelError;
        if (!ids.length) {
            const hasManualModel = String(settings?.imageModel || '').trim() || String(settings?.analysisModel || '').trim();
            const message = hasManualModel
                ? '接口已连接；模型列表不可读，将使用手动填写的模型。'
                : '接口已连接，但未返回模型列表；请在两个模型输入框手动填写模型名。';
            setApiStatus(message, 'warning');
            notify('warning', message);
            return;
        }
        if (!ids.length) throw new Error('接口已响应，但没有返回模型列表。');
        setApiStatus(`连接成功，发现 ${ids.length} 个模型`, 'success');
        notify('success', `中转站连接成功，已加载 ${ids.length} 个模型。`);
    } catch (error) {
        setApiStatus(`连接失败：${error.message || error}`, 'error');
        notify('error', `连接测试失败：${error.message || error}`);
    } finally {
        if (button) button.disabled = false;
    }
}

function messageText(message) {
    return String(message?.mes ?? message?.content ?? '')
        .replace(/<content>([\s\S]*?)<\/content>/gi, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r\n?/g, '\n')
        .trim();
}

function chatMessages() {
    const chat = getContext()?.chat;
    return Array.isArray(chat)
        ? chat.map((message, index) => ({ message, index })).filter(({ message }) => !message?.is_system && messageText(message))
        : [];
}

function latestTarget() {
    const messages = chatMessages();
    return messages.at(-1) || null;
}

function paragraphsFrom(text) {
    return String(text || '')
        .split(/\n\s*\n+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function latestParagraph() {
    const messages = chatMessages();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const paragraphs = paragraphsFrom(messageText(messages[index].message));
        if (paragraphs.length) return paragraphs.at(-1);
    }
    return '';
}

function getCharacterCardText() {
    const context = getContext() || {};
    const characters = context.characters;
    const character = Array.isArray(characters)
        ? characters[context.characterId]
        : characters?.[context.characterId];
    const data = character?.data || character || {};
    const fields = [
        ['Name', data.name || character?.name],
        ['Description', data.description],
        ['Personality', data.personality],
        ['Scenario', data.scenario],
        ['First message', data.first_mes],
        ['Example messages', data.mes_example],
    ];
    return fields
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([label, value]) => `${label}: ${value.trim()}`)
        .join('\n')
        .slice(0, 14000);
}

function getInterfaceText() {
    const visible = document.querySelector('#chat')?.innerText?.trim();
    if (visible) return visible.slice(-14000);
    return chatMessages().map(({ message }) => messageText(message)).join('\n\n').slice(-14000);
}

function getSourceText() {
    const interfaceText = getInterfaceText();
    if (settings.sourceMode === 'interface_text') return interfaceText;
    const card = getCharacterCardText();
    return [card && `Character card (authoritative):\n${card}`, interfaceText && `Current conversation text:\n${interfaceText}`]
        .filter(Boolean)
        .join('\n\n')
        .slice(-24000);
}

function buildPrompt(mode) {
    const source = getSourceText();
    const last = latestParagraph();
    const protagonist = String(settings.protagonist || '').trim();
    const sceneCast = String(settings.sceneCast || '').trim();
    const style = String(settings.style || '').trim();
    const resolution = String(settings.resolution || '1920x1080');
    const common = [
        'Create one coherent image for the current story.',
        `Output canvas: ${resolution}.`,
        style ? `Visual style: ${style}.` : '',
        'Use only details supported by the authoritative settings and text below.',
        'Do not invent a different protagonist, gender, clothing, age, location, or unrelated characters.',
        protagonist ? `Authoritative protagonist setting (must be preserved exactly):\n${protagonist}` : '',
        sceneCast ? `Authoritative scene cast setting (only these additional people may appear):\n${sceneCast}` : '',
    ].filter(Boolean);

    if (mode === 'character') {
        common.push(
            'Make a pulled-back full-body portrait of the protagonist only.',
            'Show the complete head, hands, legs, and feet without cropping. Do not add an NPC or a second person.',
        );
    } else if (mode === 'scene') {
        common.push(
            'Make a cinematic wide shot of the current scene.',
            'Keep the location, lighting, objects, action, and explicitly named cast faithful to the text.',
        );
    } else {
        common.push(
            'Illustrate the final paragraph below as the current story moment.',
            'Treat the final paragraph as the highest-priority action and composition instruction.',
            last ? `FINAL PARAGRAPH (do not replace it with an invented scene):\n${last}` : 'No final paragraph is available; use the latest visible conversation text.',
        );
    }

    if (source) common.push(`Source text (${settings.sourceMode === 'interface_text' ? 'current interface only' : 'character card plus conversation'}):\n${source}`);
    const manual = String(settings.manualPrompt || '').trim();
    if (manual) common.push(`Additional user instruction:\n${manual}`);
    const caption = String(settings.referenceCaption || '').trim();
    if (caption) common.push(`Reference image analysis (use it for visual identity; do not ignore the source text):\n${caption}`);
    common.push('Return the image directly. Preserve identity and visual continuity across images.');
    return common.join('\n\n').slice(0, 50000);
}

function extractCaption(payload) {
    const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? payload?.output_text;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
        return content.map(part => typeof part === 'string' ? part : part?.text || part?.content || '').join('\n').trim();
    }
    return '';
}

function fallbackCaption() {
    const lines = [
        'Reference image analysis is unavailable. Use this editable visual-reference draft and replace it with the details you can see.',
    ];
    if (settings.protagonist) lines.push(`Preserve protagonist setting from the left panel: ${settings.protagonist}`);
    if (settings.sceneCast) lines.push(`Preserve scene cast setting from the left panel: ${settings.sceneCast}`);
    lines.push('Describe the reference image subject, gender presentation, age range, face, hair, eyes, skin tone, clothing, accessories, pose, camera framing, background, lighting, colors, and art style. Do not invent details.');
    return lines.join('\n');
}

async function analyzeReference() {
    const image = getReferenceImage();
    if (!image) {
        notify('warning', '请先上传参考图。');
        return '';
    }
    const button = getElement('tt-gpt-analyze');
    if (button) button.disabled = true;
    setStatus('正在分析参考图…', 'pending');
    const model = String(settings.analysisModel || chooseDefaultAnalysisModel(modelIds) || 'gpt-5.6-luna').trim();
    const prompt = [
        'Analyze this reference image for an image-generation workflow.',
        'Describe only visible details: subject identity, gender presentation, age range, face, hair, eyes, skin tone, body shape, clothing, accessories, pose, camera framing, background, lighting, colors, and art style.',
        'Do not guess hidden details. Return one precise editable paragraph in English.',
        settings.protagonist ? `The left-panel protagonist setting is authoritative and must be preserved when relevant: ${settings.protagonist}` : '',
        settings.sceneCast ? `The left-panel scene cast setting is authoritative: ${settings.sceneCast}` : '',
    ].filter(Boolean).join('\n');
    try {
        const response = await requestApi('chat/completions', {
            method: 'POST',
            body: JSON.stringify({
                model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: image, detail: 'high' } },
                    ],
                }],
                max_tokens: 1200,
                temperature: 0.2,
            }),
        });
        const caption = extractCaption(await response.json());
        settings.referenceCaption = caption || fallbackCaption();
        getElement('tt-gpt-caption').value = settings.referenceCaption;
        saveSettings();
        setStatus(caption ? `分析完成（${model}），结果可编辑。` : '接口没有返回文字，已生成可编辑草稿。', caption ? 'success' : 'warning');
        return settings.referenceCaption;
    } catch (error) {
        console.error(`[${EXTENSION_ID}] reference analysis failed`, error);
        settings.referenceCaption = fallbackCaption();
        const caption = getElement('tt-gpt-caption');
        if (caption) caption.value = settings.referenceCaption;
        saveSettings();
        setStatus(`分析接口不可用，已生成可编辑草稿：${error.message || error}`, 'warning');
        return settings.referenceCaption;
    } finally {
        if (button) button.disabled = false;
    }
}

function normalizeDataUrl(value) {
    const text = String(value || '').trim();
    if (/^data:image\//i.test(text)) return text;
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length > 100) return `data:image/png;base64,${text.replace(/\s+/g, '')}`;
    return '';
}

function extractImage(payload) {
    const item = Array.isArray(payload?.data)
        ? payload.data[0]
        : Array.isArray(payload?.images)
            ? payload.images[0]
            : payload?.data;
    const b64 = item?.b64_json || item?.base64 || item?.image || (typeof item === 'string' ? item : '');
    const dataUrl = normalizeDataUrl(b64);
    if (dataUrl) return { kind: 'data', value: dataUrl };
    const url = (typeof item === 'string' ? item : null) || item?.url || item?.image_url || payload?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return { kind: 'url', value: url };
    return null;
}

function dataUrlParts(dataUrl) {
    const match = String(dataUrl || '').match(/^data:image\/([\w.+-]+);base64,(.+)$/i);
    return match ? { extension: match[1].toLowerCase().replace('jpeg', 'jpg'), base64: match[2] } : null;
}

async function saveDataUrl(dataUrl, folderName) {
    const parts = dataUrlParts(dataUrl);
    if (!parts) return dataUrl;
    try {
        const utils = await import('/scripts/utils.js');
        if (typeof utils.saveBase64AsFile === 'function') {
            return await utils.saveBase64AsFile(parts.base64, folderName || '', `tt_gpt_${Date.now()}`, parts.extension);
        }
    } catch (error) {
        console.warn(`[${EXTENSION_ID}] host image upload unavailable; using data URL`, error);
    }
    return dataUrl;
}

async function persistImage(image, folderName) {
    if (!image) throw new Error('生图接口没有返回图片。');
    if (image.kind === 'data') return saveDataUrl(image.value, folderName);
    try {
        const response = await fetch(image.value);
        if (response.ok) {
            const blob = await response.blob();
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            return await saveDataUrl(dataUrl, folderName);
        }
    } catch (error) {
        console.warn(`[${EXTENSION_ID}] generated URL could not be copied into local storage`, error);
    }
    return image.value;
}

function ensureMediaArray(message) {
    message.extra ||= {};
    if (Array.isArray(message.extra.media)) return message.extra.media;
    message.extra.media = message.extra.media ? [message.extra.media] : [];
    return message.extra.media;
}

async function appendImageToTarget(target, imageUrl, prompt, mode) {
    const context = getContext();
    if (!context || !target) throw new Error('当前聊天没有可挂载图片的文字段落。');
    const media = ensureMediaArray(target.message);
    media.push({
        url: imageUrl,
        type: 'image',
        title: prompt,
        source: 'generated',
        generation_type: `tt-gpt-${mode}`,
    });
    target.message.extra.media_display ||= 'gallery';
    target.message.extra.inline_image = false;
    target.message.extra.media_index = media.length - 1;
    const element = document.querySelector(`.mes[mesid="${target.index}"]`);
    const jq = globalThis.$;
    if (element && typeof context.appendMediaToMessage === 'function' && typeof jq === 'function') {
        context.appendMediaToMessage(target.message, jq(element), 'keep');
    }
    await context.saveChat?.();
}

async function generateImage(mode) {
    if (generationBusy) return;
    const target = latestTarget();
    if (!target) {
        notify('warning', '当前聊天还没有可以挂载图片的文字段落。');
        return;
    }
    const imageModel = String(settings.imageModel || getElement('tt-gpt-image-model-select')?.value || '').trim();
    if (!imageModel) {
        notify('warning', '请先填写或刷新生图模型。');
        getRoot()?.classList.add('tt-gpt-open');
        return;
    }
    if (!normalizeApiUrl(settings.apiUrl)) {
        notify('warning', '请先填写生图 API 地址。');
        getRoot()?.classList.add('tt-gpt-open');
        return;
    }
    generationBusy = true;
    const buttons = getRoot()?.querySelectorAll('[data-mode]') || [];
    buttons.forEach(button => { button.disabled = true; });
    setStatus(`正在生成${mode === 'character' ? '角色' : mode === 'scene' ? '场景' : '最后一段'}图片…`, 'pending');
    const prompt = buildPrompt(mode);
    const body = {
        model: imageModel,
        prompt,
        n: 1,
        size: settings.resolution || '1920x1080',
        response_format: 'b64_json',
    };
    try {
        let response;
        try {
            response = await requestHostProxy('/api/openai/generate-image', {
                ...body,
                api_url: normalizeApiUrl(settings.apiUrl),
                api_key: String(settings.apiKey || '').trim(),
            });
            if (!response) {
                response = await requestApi('images/generations', { method: 'POST', body: JSON.stringify(body) });
            }
        } catch (error) {
            if (error.status === 400) {
                delete body.response_format;
                response = await requestHostProxy('/api/openai/generate-image', {
                    ...body,
                    api_url: normalizeApiUrl(settings.apiUrl),
                    api_key: String(settings.apiKey || '').trim(),
                });
                if (!response) {
                    response = await requestApi('images/generations', { method: 'POST', body: JSON.stringify(body) });
                }
            } else {
                throw error;
            }
        }
        const image = extractImage(await response.json());
        const currentContext = getContext();
        const currentCharacter = Array.isArray(currentContext?.characters)
            ? currentContext.characters[currentContext.characterId]
            : currentContext?.characters?.[currentContext?.characterId];
        const folder = currentCharacter?.name || currentCharacter?.data?.name || '';
        const savedPath = await persistImage(image, folder);
        await appendImageToTarget(target, savedPath, prompt, mode);
        setStatus(`已添加到第 ${target.index + 1} 段文字下，可在该段图片中翻阅。`, 'success');
        notify('success', '图片已生成并添加到当前最新文字段落。');
    } catch (error) {
        console.error(`[${EXTENSION_ID}] image generation failed`, error);
        setStatus(`生图失败：${error.message || error}`, 'error');
        notify('error', `生图失败：${error.message || error}`);
    } finally {
        generationBusy = false;
        buttons.forEach(button => { button.disabled = false; });
    }
}

function readFormValue(element) {
    if (!element) return '';
    if (element.type === 'checkbox') return Boolean(element.checked);
    return String(element.value ?? '');
}

function writeFormValue(element, value) {
    if (!element) return;
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else element.value = value ?? '';
}

function syncFormFromSettings() {
    const root = getRoot();
    if (!root || !settings) return;
    root.querySelectorAll('[data-setting]').forEach(element => writeFormValue(element, settings[element.dataset.setting]));
    const preview = getElement('tt-gpt-reference-preview');
    const image = getReferenceImage();
    if (preview) {
        preview.src = image;
        preview.hidden = !image;
    }
    const caption = getElement('tt-gpt-caption');
    if (caption) caption.value = settings.referenceCaption || '';
    fillModelSelects();
}

function handleSettingChange(element) {
    const key = element.dataset.setting;
    if (!key || !settings) return;
    settings[key] = readFormValue(element);
    if (key === 'apiUrl' || key === 'apiKey') setApiStatus('配置已修改，点击连接测试。', 'pending');
    saveSettings();
}

function bindDrag(panel, handle) {
    let drag = null;
    handle.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        const rect = panel.getBoundingClientRect();
        drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
        if (!drag) return;
        const margin = 8;
        const rect = panel.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        const left = Math.min(maxLeft, Math.max(margin, event.clientX - drag.offsetX));
        const top = Math.min(maxTop, Math.max(margin, event.clientY - drag.offsetY));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    });
    const stop = event => {
        if (!drag) return;
        drag = null;
        handle.releasePointerCapture?.(event.pointerId);
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

function buildUi() {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
        <div class="tt-gpt-toolbar" role="toolbar" aria-label="GPT 生图">
            <button type="button" class="tt-gpt-action" data-mode="character" title="读取角色卡和对话，生成主角">
                <i class="fa-solid fa-user"></i><span>角色</span>
            </button>
            <button type="button" class="tt-gpt-action" data-mode="scene" title="读取当前对话，生成场景">
                <i class="fa-solid fa-mountain-sun"></i><span>场景</span>
            </button>
            <button type="button" class="tt-gpt-action" data-mode="last" title="固定读取最新文字段落">
                <i class="fa-solid fa-paragraph"></i><span>最后一段</span>
            </button>
            <button type="button" class="tt-gpt-action tt-gpt-settings-button" data-action="toggle" title="打开生图设置">
                <i class="fa-solid fa-sliders"></i><span>设置</span>
            </button>
        </div>
        <section class="tt-gpt-panel" data-tt-mobile-surface="free-window" aria-label="GPT 生图控制面板">
            <header class="tt-gpt-panel-header" data-drag-handle>
                <strong>GPT 生图控制</strong>
                <div class="tt-gpt-header-actions">
                    <button type="button" data-action="generate" title="按当前设置生成"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
                    <button type="button" data-action="minimize" title="最小化"><i class="fa-solid fa-minus"></i></button>
                </div>
            </header>
            <div class="tt-gpt-panel-body">
                <div class="tt-gpt-grid">
                    <label>生图 API 地址<input type="url" data-setting="apiUrl" placeholder="https://中转站/v1" autocomplete="url"></label>
                    <label>生图 API Key<input type="password" data-setting="apiKey" placeholder="输入中转站 Key" autocomplete="off"></label>
                </div>
                <div class="tt-gpt-inline">
                    <button type="button" class="menu_button" id="tt-gpt-api-test" data-action="test">连接测试</button>
                    <button type="button" class="menu_button" data-action="refresh-models">刷新模型</button>
                    <span id="tt-gpt-api-status" aria-live="polite"></span>
                </div>
                <div class="tt-gpt-grid">
                    <label>生图模型<select id="tt-gpt-image-model-select" data-model-select="imageModel"></select></label>
                    <label>生图模型（可手填）<input type="text" data-setting="imageModel" placeholder="例如 gpt-image-1"></label>
                    <label>分析模型<select id="tt-gpt-analysis-model-select" data-model-select="analysisModel"></select></label>
                    <label>分析模型（可手填）<input type="text" data-setting="analysisModel" placeholder="例如 gpt-5.6-luna"></label>
                    <label>分辨率<select data-setting="resolution">${RESOLUTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
                    <label>生成风格<select data-setting="style">${STYLES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
                    <label>内容来源<select data-setting="sourceMode"><option value="card_text">角色卡 + 当前文字</option><option value="interface_text">只读当前界面文字</option></select></label>
                    <label class="tt-gpt-checkbox"><input type="checkbox" data-setting="autoAnalyze">上传参考图后自动分析</label>
                </div>
                <label>附加提示词<textarea data-setting="manualPrompt" rows="3" placeholder="每次生图都会附加的要求"></textarea></label>
                <div class="tt-gpt-grid">
                    <label>主角设定（只控制主角）<textarea data-setting="protagonist" rows="3" placeholder="例如：姓名、性别、年龄、发型、服装、外貌"></textarea></label>
                    <label>场景角色设定（只控制场景中出现的人）<textarea data-setting="sceneCast" rows="3" placeholder="例如：主角和登记员；不要添加其他人物"></textarea></label>
                </div>
                <div class="tt-gpt-reference-row">
                    <div class="tt-gpt-reference-file">
                        <label>图像参考<input id="tt-gpt-reference-file" type="file" accept="image/png,image/jpeg,image/webp"></label>
                        <img id="tt-gpt-reference-preview" alt="参考图预览" hidden>
                        <button type="button" class="menu_button" data-action="clear-reference">清除参考</button>
                    </div>
                    <div class="tt-gpt-reference-analysis">
                        <label>图像分析结果（可编辑）<textarea id="tt-gpt-caption" data-setting="referenceCaption" rows="9" placeholder="上传参考图后会自动填入分析结果"></textarea></label>
                        <button type="button" class="menu_button" id="tt-gpt-analyze" data-action="analyze">重新分析参考图</button>
                    </div>
                </div>
                <div id="tt-gpt-status" class="tt-gpt-status" role="status" aria-live="polite"></div>
            </div>
        </section>`;
    return root;
}

function setupUi(root) {
    const panel = root.querySelector('.tt-gpt-panel');
    const handle = root.querySelector('[data-drag-handle]');
    root.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || !root.contains(button)) return;
        const action = button.dataset.action;
        const mode = button.dataset.mode;
        if (mode) {
            void generateImage(mode);
            return;
        }
        if (action === 'toggle') root.classList.toggle('tt-gpt-open');
        if (action === 'minimize') root.classList.toggle('tt-gpt-minimized');
        if (action === 'test') void testConnection();
        if (action === 'refresh-models') void refreshModels();
        if (action === 'analyze') void analyzeReference();
        if (action === 'clear-reference') {
            setReferenceImage('');
            settings.referenceCaption = '';
            getElement('tt-gpt-caption').value = '';
            getElement('tt-gpt-reference-preview').hidden = true;
            getElement('tt-gpt-reference-file').value = '';
            saveSettings();
            setStatus('参考图和分析结果已清除。', 'success');
        }
    });
    root.addEventListener('input', event => {
        const element = event.target.closest('[data-setting]');
        if (element) handleSettingChange(element);
    });
    root.addEventListener('change', event => {
        const element = event.target.closest('[data-setting]');
        if (element) handleSettingChange(element);
        const modelSelect = event.target.closest('[data-model-select]');
        if (modelSelect && modelSelect.value) {
            const key = modelSelect.dataset.modelSelect;
            settings[key] = modelSelect.value;
            const input = root.querySelector(`[data-setting="${key}"]`);
            if (input) input.value = modelSelect.value;
            saveSettings();
        }
    });
    root.querySelector('#tt-gpt-reference-file')?.addEventListener('change', event => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            const dataUrl = String(reader.result || '');
            setReferenceImage(dataUrl);
            const preview = getElement('tt-gpt-reference-preview');
            preview.src = dataUrl;
            preview.hidden = false;
            settings.referenceCaption = '';
            getElement('tt-gpt-caption').value = '';
            saveSettings();
            setStatus(settings.autoAnalyze ? '参考图已上传，正在自动分析…' : '参考图已上传，点击分析或手动填写结果。', 'pending');
            if (settings.autoAnalyze) await analyzeReference();
        };
        reader.readAsDataURL(file);
    });
    bindDrag(panel, handle);
    syncFormFromSettings();
    loadCachedModels();
    fillModelSelects();
    if (settings.apiUrl) void refreshModels({ silent: true });
}

function mountUi() {
    if (getRoot()) return true;
    const container = document.querySelector('#sd_wand_container, #leftSendForm, #send_form');
    if (!container) return false;
    const root = buildUi();
    container.appendChild(root);
    setupUi(root);
    return true;
}

async function activateImpl() {
    await waitForHostReady();
    hostContext = globalThis.SillyTavern?.getContext?.() || null;
    if (!hostContext) {
        console.warn(`[${EXTENSION_ID}] SillyTavern context is not ready`);
        return;
    }
    loadSettings();
    if (!mountUi()) {
        mountObserver = new MutationObserver(() => {
            if (mountUi()) {
                mountObserver?.disconnect();
                mountObserver = null;
            }
        });
        mountObserver.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => mountObserver?.disconnect(), 30000);
    }
}

export function activate() {
    activationPromise ||= activateImpl();
    return activationPromise;
}

globalThis[EXTENSION_ID] = { activate, generateImage, analyzeReference };
void activate();
