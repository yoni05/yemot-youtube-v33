const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ytdl = require('@distube/ytdl-core');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const YT_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const YT_KEY2 = (process.env.YOUTUBE_API_KEY2 || '').trim();
const YT_KEYS = [YT_KEY, YT_KEY2].filter(Boolean);
let activeYtKeyIndex = 0;

const YM = 'https://www.call2all.co.il/ym/api/';
const ADMIN_LOG_EXT = '8';

// שלוחת החיפוש ביוטיוב שאליה חוזרים בסיום השמעה או בלחיצה על סולמית (#)
const YOUTUBE_MAIN_EXT = '/1/0000000144';
const RESULTS_PER_PAGE = 7;

let cachedModelName = null;
const folderCounters = {};
const userNamesCache = new Map();
const configuredPlayfileDirs = new Set();
const userSessionState = new Map();

function lastVal(param) {
    if (Array.isArray(param)) {
        return String(param[param.length - 1] || '').trim();
    }
    return String(param || '').trim();
}

// ניקוי טקסט וכותרות יוטיוב מתווים ששוברים את מנוע ההקראה (TTS) של ימות המשיח
function sanitizeForYemotTts(str, maxLen = 55) {
    return String(str || '')
        .replace(/&quot;/g, ' ')
        .replace(/&#39;/g, ' ')
        .replace(/&amp;/g, ' ')
        .replace(/[^א-תa-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

// המרת אורך סרטון מפורמט יוטיוב (ISO 8601) לשניות ולטקסט הקראה בעברית (לפני תחילת הניגון)
function parseIsoDurationToHebrew(isoDuration) {
    if (!isoDuration) return { seconds: 0, text: '' };
    const match = String(isoDuration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return { seconds: 0, text: '' };

    const hours = parseInt(match[1] || '0', 10);
    const minutes = parseInt(match[2] || '0', 10);
    const seconds = parseInt(match[3] || '0', 10);
    const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;

    const parts = [];
    if (hours === 1) parts.push('שעה');
    else if (hours === 2) parts.push('שעתיים');
    else if (hours > 2) parts.push(`${hours} שעות`);

    if (minutes === 1) parts.push('דקה אחת');
    else if (minutes > 1) parts.push(`${minutes} דקות`);

    if (hours === 0 && seconds > 0) {
        parts.push(`${seconds} שניות`);
    }

    return {
        seconds: totalSeconds,
        text: parts.join(' ו ')
    };
}

// בניית טקסט ההקראה עבור דף תוצאות ספציפי (7 תוצאות בכל דף - שם הסרטון בלבד)
function buildPagePromptText(cleanQuery, allResults, pageIndex) {
    const startIdx = pageIndex * RESULTS_PER_PAGE;
    const pageItems = allResults.slice(startIdx, startIdx + RESULTS_PER_PAGE);
    const hasMorePages = allResults.length > (startIdx + RESULTS_PER_PAGE);

    const optionsTextParts = pageItems.map((item, idx) => `לתוצאה ${idx + 1} ${item.title} הקישו ${idx + 1}`);
    const headerText = (pageIndex === 0)
        ? `נקלט ${cleanQuery}`
        : `המשך תוצאות עבור ${cleanQuery}`;

    const moreText = hasMorePages
        ? 'לעוד תוצאות אחרות הקישו 9'
        : (allResults.length > RESULTS_PER_PAGE ? 'לחזרה לתוצאות הראשונות הקישו 9' : '');

    return `${headerText} ${optionsTextParts.join(' ')} לחיפוש מחדש הקישו 8 ${moreText} לחזרה לתפריט הקישו 0`.replace(/\s+/g, ' ').trim();
}

async function fetchWithTimeout(url, options = {}, timeout = 20000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

// פנייה ל-YouTube API עם מעבר אוטומטי מ-YOUTUBE_API_KEY ל-YOUTUBE_API_KEY2 במקרה של סיום מכסה
async function fetchYouTubeWithFallback(baseUrlWithoutKey, timeoutMs = 6500) {
    const keysToTry = YT_KEYS.length > 0 ? [
        YT_KEYS[activeYtKeyIndex % YT_KEYS.length],
        ...YT_KEYS.filter((_, idx) => idx !== (activeYtKeyIndex % YT_KEYS.length))
    ] : [''];

    let lastRes = null;
    let lastData = null;
    let lastErr = null;

    for (const key of keysToTry) {
        const sep = baseUrlWithoutKey.includes('?') ? '&' : '?';
        const fullUrl = `${baseUrlWithoutKey}${sep}key=${encodeURIComponent(key)}`;
        try {
            const res = await fetchWithTimeout(fullUrl, {}, timeoutMs);
            const data = await res.json();
            if (res.ok) {
                const usedIdx = YT_KEYS.indexOf(key);
                if (usedIdx !== -1 && usedIdx !== activeYtKeyIndex) {
                    console.log(`[YouTube API] Switched active key to YOUTUBE_API_KEY${usedIdx === 0 ? '' : '2'}`);
                    activeYtKeyIndex = usedIdx;
                }
                return { res, data };
            }
            console.warn(`[YouTube API Key #${YT_KEYS.indexOf(key) + 1} Quota/Error] HTTP ${res.status}:`, data?.error?.message || '');
            lastRes = res;
            lastData = data;
        } catch (err) {
            console.warn(`[YouTube API Key #${YT_KEYS.indexOf(key) + 1} Fetch Error]:`, err.message);
            lastErr = err;
        }
    }

    if (lastRes) {
        return { res: lastRes, data: lastData };
    }
    throw lastErr || new Error('All YouTube API keys failed');
}

async function uploadTextToExactPath(textContent, exactTargetPath, fileNameLabel = 'file.txt') {
    const form = new FormData();
    form.append('token', TOKEN);
    form.append('path', exactTargetPath);
    form.append('convertAudio', '0');
    form.append('file', new Blob([Buffer.from(textContent, 'utf8')], { type: 'text/plain; charset=utf-8' }), fileNameLabel);
    await fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: form }, 12000);
}

// בדיקה אם משתמש כבר רשום במערכת
async function getUserNameIfRegistered(phone) {
    if (userNamesCache.has(phone)) {
        return userNamesCache.get(phone);
    }
    const folderPath = `ivr2:/users/${phone}`;
    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 6000);
        if (res.ok) {
            const data = await res.json();
            const files = data.files || [];
            const hasNameFile = files.some(f => {
                const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                const low = String(fname).toLowerCase();
                return low === 'name.txt' || low === 'name.wav';
            });
            if (hasNameFile) {
                try {
                    const dlUrl = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath + '/name.txt')}`;
                    const dlRes = await fetchWithTimeout(dlUrl, {}, 5000);
                    if (dlRes.ok) {
                        const nameTxt = (await dlRes.text()).trim();
                        if (nameTxt && !nameTxt.includes('responseStatus') && !nameTxt.includes('EXCEPTION')) {
                            userNamesCache.set(phone, nameTxt);
                            return nameTxt;
                        }
                    }
                } catch (e) {}
                userNamesCache.set(phone, 'משתמש רשום');
                return 'משתמש רשום';
            }
        }
    } catch (e) {
        console.warn('[Check User Warning]', e.message);
    }
    return null;
}

// הגדרת תיקיית הפלייליסט של המשתמש כנגן קבצים רגיל עם חזרה אוטומטית ליוטיוב בלחיצה על # או סיום השמעה
async function ensurePlayfileExtension(folderPathStr) {
    const clean = String(folderPathStr).replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    if (configuredPlayfileDirs.has(clean)) return;

    try {
        const body = new URLSearchParams({
            token: TOKEN,
            path: `ivr2:/${clean}`,
            type: 'playfile'
        });
        await fetchWithTimeout(`${YM}UpdateExtension`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        }, 7000);

        const playfileIni = [
            'type=playfile',
            `playfile_end_goto=${YOUTUBE_MAIN_EXT}`,
            `empty_goto=${YOUTUBE_MAIN_EXT}`,
            `root_goto=${YOUTUBE_MAIN_EXT}`,
            `control_play_return=${YOUTUBE_MAIN_EXT}`,
            `control_play#=${YOUTUBE_MAIN_EXT}`
        ].join('\r\n') + '\r\n';
        await uploadTextToExactPath(playfileIni, `ivr2:/${clean}/ext.ini`, 'ext.ini');

        configuredPlayfileDirs.add(clean);
    } catch (e) {
        console.warn(`[Ensure Playfile ${clean}]`, e.message);
    }
}

// איתור המספר הפנוי הבא בתיקייה בימות המשיח (שומר בזיכרון כדי לא לעכב הורדה של 15 דקות)
async function getNextFileNumberStr(folder, reserveCount = 1) {
    const cleanFolder = String(folder || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');

    // אם כבר בדקנו את התיקייה הזו, נותנים מיד את המספר הבא מהזיכרון ב-0 שניות!
    if (folderCounters[cleanFolder] !== undefined) {
        const startNum = folderCounters[cleanFolder] + 1;
        folderCounters[cleanFolder] += reserveCount;
        const result = [];
        for (let i = 0; i < reserveCount; i++) {
            result.push(String(startNum + i).padStart(3, '0'));
        }
        return reserveCount === 1 ? result[0] : result;
    }

    const folderPath = cleanFolder ? `ivr2:/${cleanFolder}` : `ivr2:/`;
    let maxExisting = -1;

    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 5000);
        if (res.ok) {
            const data = await res.json();
            const files = data.files || [];
            for (const f of files) {
                const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                const m = String(fname).match(/^(\d+)\.(wav|tts|txt|mp3)$/i);
                if (m) {
                    const num = parseInt(m[1], 10);
                    if (!isNaN(num) && num < 900 && num > maxExisting) {
                        maxExisting = num;
                    }
                }
            }
        }
    } catch (e) {
        console.warn(`[GetIVR2Dir] Warning checking ${folderPath}:`, e.message);
    }

    const baseNum = Math.max(maxExisting, 0);
    const startNum = baseNum + 1;
    folderCounters[cleanFolder] = baseNum + reserveCount;

    const result = [];
    for (let i = 0; i < reserveCount; i++) {
        result.push(String(startNum + i).padStart(3, '0'));
    }
    return reserveCount === 1 ? result[0] : result;
}

// העלאת קובץ WAV מוכן לימות המשיח
async function uploadWavBufferToExactPath(wavBuffer, exactTargetPath, fileNameLabel = 'audio.wav', timeoutMs = 45000) {
    const formData = new FormData();
    formData.append('token', TOKEN);
    formData.append('path', exactTargetPath);
    formData.append('convertAudio', '0');
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), fileNameLabel);

    const upRes = await fetchWithTimeout(`${YM}UploadFile`, {
        method: 'POST',
        body: formData
    }, timeoutMs);

    const upText = await upRes.text();
    console.log(`[Yemot Upload -> ${exactTargetPath}] (${wavBuffer.length} bytes) Response:`, upText.slice(0, 180));
    return upText;
}

// תיעוד פעולות והורדות למנהל המערכת בשלוחה 8
async function saveAdminLogToExt8(callerPhone, userName, categoryLabel, searchQuery, downloadedTitle, statusText) {
    try {
        const nextNum = await getNextFileNumberStr(ADMIN_LOG_EXT, 1);
        const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        
        const ttsSummary = `משתמש ${userName} טלפון ${callerPhone} חיפש ב${categoryLabel} את ${searchQuery}. סטטוס: ${statusText}`;
        await uploadTextToExactPath(ttsSummary, `ivr2:/${ADMIN_LOG_EXT}/${nextNum}.tts`, `${nextNum}.tts`);

        const txtDetails = [
            `שם משתמש: ${userName}`,
            `מספר טלפון: ${callerPhone}`,
            `קובץ הקלטת שם: ivr2:/users/${callerPhone}/name.wav`,
            `קטגוריה: ${categoryLabel}`,
            `מילות חיפוש: ${searchQuery}`,
            `כותרת סרטון: ${downloadedTitle || 'לא הורד'}`,
            `סטטוס: ${statusText}`,
            `זמן פעולה: ${nowStr}`
        ].join('\r\n') + '\r\n';

        await uploadTextToExactPath(txtDetails, `ivr2:/${ADMIN_LOG_EXT}/${nextNum}.txt`, `${nextNum}.txt`);
    } catch (err) {
        console.warn('[Admin Log Ext 8] Error:', err.message);
    }
}

// הורדת הקלטה מימות המשיח
async function downloadRecordingFromYemot(recordPath, apiDir) {
    const cleanPath = String(recordPath).replace(/^ivr2:\/*/, '').replace(/^\/*/, '');
    const cleanDir = String(apiDir || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    
    const candidates = [
        `ivr2:/${cleanPath}`,
        `ivr2:${cleanPath}`
    ];
    if (cleanDir && !cleanPath.startsWith(cleanDir + '/')) {
        candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}`);
    }
    if (!cleanPath.toLowerCase().endsWith('.wav')) {
        candidates.unshift(`ivr2:/${cleanPath}.wav`);
        if (cleanDir) candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}.wav`);
    }

    const uniquePaths = [...new Set(candidates)];
    let lastYemotResponse = '';
    for (const p of uniquePaths) {
        const url = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(p)}`;
        try {
            const res = await fetchWithTimeout(url, {}, 10000);
            if (!res.ok) {
                lastYemotResponse = `HTTP_${res.status}`;
                continue;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            const headStr = buf.toString('utf8', 0, Math.min(buf.length, 150));
            
            if (buf.length > 200 && !headStr.includes('responseStatus') && !headStr.includes('EXCEPTION')) {
                console.log(`[Yemot Download] Success from ${p} (${buf.length} bytes)`);
                return buf;
            } else {
                lastYemotResponse = headStr;
            }
        } catch (e) {
            lastYemotResponse = e.message;
        }
    }
    throw new Error('YEMOT_DOWNLOAD_ERR: ' + lastYemotResponse);
}

// בחירת מודל Gemini מהיר לתמלול
async function getFastGeminiModels() {
    const defaultFastOrder = [
        'gemini-flash-lite-latest',
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.5-transcribe',
        'gemini-flash-latest',
        'gemini-3.6-flash'
    ];
    if (cachedModelName) {
        return [cachedModelName, ...defaultFastOrder.filter(m => m !== cachedModelName)];
    }
    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 6000);
        if (res.ok) {
            const data = await res.json();
            const available = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(m => !m.includes('2.5') && !m.includes('1.5') && !m.includes('tts') && !m.includes('image') && !m.includes('robotics') && !m.includes('research') && !m.includes('computer-use'));

            const matched = [];
            for (const pref of defaultFastOrder) {
                if (available.includes(pref)) matched.push(pref);
            }
            for (const m of available) {
                if ((m.includes('flash') || m.includes('transcribe')) && !matched.includes(m)) {
                    matched.push(m);
                }
            }
            if (matched.length > 0) {
                cachedModelName = matched[0];
                return matched;
            }
        }
    } catch (e) {}
    return defaultFastOrder;
}

async function transcribeAudio(audioBase64) {
    const modelsToTry = await getFastGeminiModels();
    const prompt = "תמלל את ההקלטה לעברית. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת, ללא סימני פיסוק וללא הסברים.";

    let lastErr = '';
    for (const model of modelsToTry.slice(0, 4)) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        try {
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }
                        ]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 60
                    }
                })
            }, 10000);

            if (res.ok) {
                cachedModelName = model;
                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                console.log(`[Gemini] Model ${model} success:`, JSON.stringify(text));
                return text;
            }

            lastErr = await res.text();
            if (cachedModelName === model) cachedModelName = null;
        } catch (err) {
            lastErr = err.message;
            if (cachedModelName === model) cachedModelName = null;
        }
    }
    throw new Error('GEMINI_ERR: ' + lastErr);
}

// חיתוך והמרה מהירה של מקטע ספציפי לקובץ WAV תקני לימות המשיח (8000Hz Mono PCM)
async function convertSegmentToWavFast(inputPath, outputWavPath, startSec = 0, durationSec = 900) {
    await new Promise((resolve, reject) => {
        const ffTimer = setTimeout(() => reject(new Error('Local FFmpeg segment timeout')), 45000);
        let cmd = ffmpeg(inputPath);

        // חיתוך מהיר ברמת הקלט (מונע מ-FFmpeg לסרוק את כל השיעור לאט)
        const inOpts = [];
        if (startSec > 0) {
            inOpts.push(`-ss ${startSec}`);
        }
        if (inOpts.length > 0) {
            cmd = cmd.inputOptions(inOpts);
        }

        cmd.duration(durationSec)
            .format('wav')
            .audioCodec('pcm_s16le')
            .audioChannels(1)
            .audioFrequency(8000)
            .outputOptions(['-threads 0'])
            .on('end', () => {
                clearTimeout(ffTimer);
                resolve();
            })
            .on('error', (err) => {
                clearTimeout(ffTimer);
                reject(err);
            })
            .save(outputWavPath);
    });
}

// איתור קישורי פרוקסי מהירים - בודק את כל 5 השרתים במקביל תוך שנייה אחת!
async function getFastStreamUrls(videoId) {
    const invidiousHosts = [
        'https://yt.chocolatemoo53.com',
        'https://invidious.nerdvpn.de',
        'https://inv.tux.pizza',
        'https://invidious.privacyredirect.com',
        'https://inv.nadeko.net'
    ];

    const urls = [];

    try {
        const fastHostUrls = await Promise.any(invidiousHosts.map(async (host) => {
            const apiRes = await fetchWithTimeout(`${host}/api/v1/videos/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 2500);
            if (!apiRes.ok) throw new Error('Not OK');
            const data = await apiRes.json();
            const formats = (data.adaptiveFormats || []).filter(f => (f.type || '').startsWith('audio/'));
            if (formats.length === 0) throw new Error('No audio');
            formats.sort((a, b) => (parseInt(a.bitrate) || 999999) - (parseInt(b.bitrate) || 999999));
            return formats.slice(0, 2).map(fmt => `${host}/latest_version?id=${videoId}&itag=${fmt.itag || 139}&local=true`);
        }));
        urls.push(...fastHostUrls);
    } catch (e) {}

    for (const host of invidiousHosts.slice(0, 4)) {
        urls.push(`${host}/latest_version?id=${videoId}&itag=139&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=249&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=140&local=true`);
    }

    return [...new Set(urls)];
}

// הורדה מואצת במקטעים
async function downloadStreamFastToLocalFile(streamUrl, targetFilePath, maxBytes, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let downloaded = 0;

    try {
        const res = await fetch(streamUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Range': `bytes=0-${maxBytes}`
            },
            signal: controller.signal
        });

        if (!res.ok && res.status !== 206) {
            throw new Error(`HTTP ${res.status}`);
        }

        const cType = (res.headers.get('content-type') || '').toLowerCase();
        if (cType.includes('text/html') || cType.includes('application/json')) {
            throw new Error(`Invalid content-type: ${cType}`);
        }

        const fileStream = fs.createWriteStream(targetFilePath);
        for await (const chunk of res.body) {
            downloaded += chunk.length;
            fileStream.write(chunk);
            if (downloaded >= maxBytes) {
                try { controller.abort(); } catch (e) {}
                break;
            }
        }

        await new Promise(r => fileStream.end(r));
        clearTimeout(timer);

        if (downloaded < 30000) {
            throw new Error(`Downloaded too small (${downloaded} bytes)`);
        }
        return downloaded;
    } catch (e) {
        clearTimeout(timer);
        if (downloaded >= 250000 && fs.existsSync(targetFilePath)) {
            return downloaded;
        }
        throw e;
    }
}

// הורדה חכמה ואחידה לשירים ולשיעורים: עד 15 דקות קובץ אחד, ומעל 15 דקות מחלק למספר החלקים המדויק!
async function downloadAndPreparePlayback(videoId, livePlayFolder, archiveUserFolder, durationSeconds = 0) {
    const cleanLive = String(livePlayFolder).replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    const cleanArchive = String(archiveUserFolder).replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');

    const streamUrls = await getFastStreamUrls(videoId);
    let workingUrl = null;
    let initialDownloadedBytes = 0;
    const QUICK_LIMIT_BYTES = 5.5 * 1024 * 1024;

    const tmpQuickInput = path.join(os.tmpdir(), `quick_in_${videoId}_${Date.now()}.audio`);
    const tmpQuickWav = path.join(os.tmpdir(), `quick_out_${videoId}_${Date.now()}.wav`);

    try {
        for (const sUrl of streamUrls.slice(0, 6)) {
            try {
                initialDownloadedBytes = await downloadStreamFastToLocalFile(sUrl, tmpQuickInput, QUICK_LIMIT_BYTES, 8500);
                await convertSegmentToWavFast(tmpQuickInput, tmpQuickWav, 0, 900);
                if (fs.existsSync(tmpQuickWav) && fs.statSync(tmpQuickWav).size > 20000) {
                    workingUrl = sUrl;
                    break;
                }
            } catch (err) {
                console.warn(`[Part 1 Fast Start] URL attempt failed: ${err.message}`);
            }
        }

        if (!workingUrl) {
            await new Promise((resolve, reject) => {
                let dl = 0;
                const ws = fs.createWriteStream(tmpQuickInput);
                const st = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly', quality: 'lowestaudio' });
                const tm = setTimeout(() => { try { st.destroy(); } catch (e) {} ws.end(resolve); }, 8500);
                st.on('data', c => {
                    dl += c.length;
                    ws.write(c);
                    if (dl >= QUICK_LIMIT_BYTES) {
                        clearTimeout(tm);
                        try { st.destroy(); } catch (e) {}
                        ws.end(resolve);
                    }
                });
                st.on('end', () => { clearTimeout(tm); ws.end(resolve); });
                st.on('error', e => { clearTimeout(tm); ws.end(() => reject(e)); });
            });
            if (fs.existsSync(tmpQuickInput)) {
                initialDownloadedBytes = fs.statSync(tmpQuickInput).size;
            }
            await convertSegmentToWavFast(tmpQuickInput, tmpQuickWav, 0, 900);
        }

        let quickWavBuf = await fs.promises.readFile(tmpQuickWav);
        fs.promises.unlink(tmpQuickInput).catch(() => null);
        fs.promises.unlink(tmpQuickWav).catch(() => null);

        const hitDownloadCeiling = initialDownloadedBytes >= (QUICK_LIMIT_BYTES - 350000);
        const isFullFifteenMin = quickWavBuf.length >= 13800000;
        const isLongStream = (durationSeconds > 900)
            ? true
            : (durationSeconds > 0 ? false : (hitDownloadCeiling || isFullFifteenMin));

        // אם הסרטון עד 15 דקות (בשירים או בשיעורים) -> מעלים קובץ אחד בלבד
        if (!isLongStream) {
            const singleNum = await getNextFileNumberStr(cleanLive, 1);
            const singlePath = `ivr2:/${cleanLive}/${singleNum}.wav`;
            await uploadWavBufferToExactPath(quickWavBuf, singlePath, `${singleNum}.wav`, 25000);

            (async () => {
                try {
                    await ensurePlayfileExtension(cleanArchive);
                    const archNum = await getNextFileNumberStr(cleanArchive, 1);
                    const archTargetPath = `ivr2:/${cleanArchive}/${archNum}.wav`;
                    await uploadWavBufferToExactPath(quickWavBuf, archTargetPath, `${archNum}.wav`, 30000);
                    quickWavBuf = null;
                } catch (archErr) {
                    quickWavBuf = null;
                }
            })();

            return `f-/${cleanLive}/${singleNum}`;
        }

        // אם הסרטון ארוך מ-15 דקות -> מחשבים את מספר החלקים המדויק לפי אורך הסרטון (כדי שלא יחפש חלקים שלא קיימים!)
        const TOTAL_PARTS = durationSeconds > 900
            ? Math.min(6, Math.max(2, Math.ceil((durationSeconds - 10) / 900)))
            : 6;

        const rawPartNums = await getNextFileNumberStr(cleanLive, TOTAL_PARTS);
        const partNums = Array.isArray(rawPartNums) ? rawPartNums : [rawPartNums];
        const partPaths = partNums.map(num => `ivr2:/${cleanLive}/${num}.wav`);
        const partCmds = partNums.map(num => `f-/${cleanLive}/${num}`);
        const chainedPlayCommand = partCmds.join('.');

        // העלאה מיידית של ההתחלה לתיקיית ההשמעה החיה כדי שהמשתמש ישמע מיד בלי להמתין
        await uploadWavBufferToExactPath(quickWavBuf, partPaths[0], `${partNums[0]}.wav`, 20000);

        // ברקע: מורידים את כל הסרטון, מעלים את חלקי ההמשך להשמעה החיה, ולתיקייה האישית מעלים הפוך (קודם הסוף ואז ההתחלה!)
        (async () => {
            const tmpFullIn = path.join(os.tmpdir(), `full_in_${videoId}_${Date.now()}.audio`);
            const validSegments = [];

            try {
                const MAX_FULL_BYTES = 48 * 1024 * 1024;
                let fullBytes = 0;
                let downloadedFullOk = false;

                if (workingUrl) {
                    try {
                        fullBytes = await downloadStreamFastToLocalFile(workingUrl, tmpFullIn, MAX_FULL_BYTES, 90000);
                        downloadedFullOk = true;
                    } catch (e) {
                        downloadedFullOk = false;
                    }
                }

                if (!downloadedFullOk) {
                    await new Promise((resolve, reject) => {
                        const ws = fs.createWriteStream(tmpFullIn);
                        const st = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly', quality: 'lowestaudio' });
                        const tm = setTimeout(() => { try { st.destroy(); } catch (e) {} ws.end(resolve); }, 90000);
                        st.on('data', c => {
                            fullBytes += c.length;
                            ws.write(c);
                            if (fullBytes >= MAX_FULL_BYTES) {
                                clearTimeout(tm);
                                try { st.destroy(); } catch (e) {}
                                ws.end(resolve);
                            }
                        });
                        st.on('end', () => { clearTimeout(tm); ws.end(resolve); });
                        st.on('error', e => { clearTimeout(tm); ws.end(() => reject(e)); });
                    });
                }

                const segments = [];
                for (let idx = 0; idx < TOTAL_PARTS; idx++) {
                    segments.push({ index: idx, start: idx * 900, duration: 900 });
                }

                // שלב 1: העלאת חלקי ההמשך להשמעה החיה
                for (const seg of segments) {
                    const tmpPartWav = path.join(os.tmpdir(), `live_${seg.index}_${videoId}_${Date.now()}.wav`);
                    try {
                        await convertSegmentToWavFast(tmpFullIn, tmpPartWav, seg.start, seg.duration);
                        if (fs.existsSync(tmpPartWav)) {
                            const stat = fs.statSync(tmpPartWav);
                            if (stat.size > 1000) {
                                validSegments.push(seg);
                                if (seg.index > 0) {
                                    const partBuf = await fs.promises.readFile(tmpPartWav);
                                    await uploadWavBufferToExactPath(partBuf, partPaths[seg.index], `${partNums[seg.index]}.wav`, 45000);
                                }
                            } else {
                                fs.promises.unlink(tmpPartWav).catch(() => null);
                                break;
                            }
                        }
                    } catch (segErr) {
                        fs.promises.unlink(tmpPartWav).catch(() => null);
                        break;
                    }
                    fs.promises.unlink(tmpPartWav).catch(() => null);
                }

                // שלב 2: העלאה הפוכה לשלוחה האישית (קודם הסוף ובסוף ההתחלה כדי שישמעו לפי הסדר!)
                await ensurePlayfileExtension(cleanArchive);

                if (validSegments.length > 0) {
                    const rawArchNums = await getNextFileNumberStr(cleanArchive, validSegments.length);
                    const archNums = Array.isArray(rawArchNums) ? rawArchNums : [rawArchNums];
                    const reversedSegments = [...validSegments].reverse();

                    for (let i = 0; i < reversedSegments.length; i++) {
                        const seg = reversedSegments[i];
                        const archNum = archNums[i];
                        const archTargetPath = `ivr2:/${cleanArchive}/${archNum}.wav`;
                        const tmpArchWav = path.join(os.tmpdir(), `arch_${seg.index}_${videoId}_${Date.now()}.wav`);

                        try {
                            await convertSegmentToWavFast(tmpFullIn, tmpArchWav, seg.start, seg.duration);
                            if (fs.existsSync(tmpArchWav)) {
                                const archBuf = await fs.promises.readFile(tmpArchWav);
                                await uploadWavBufferToExactPath(archBuf, archTargetPath, `${archNum}.wav`, 45000);
                                console.log(`[Reverse Archive] Uploaded Part ${seg.index + 1} -> ${archTargetPath}`);
                            }
                        } catch (archSegErr) {
                            console.warn(`[Reverse Archive Part ${seg.index + 1} Error]:`, archSegErr.message);
                        } finally {
                            fs.promises.unlink(tmpArchWav).catch(() => null);
                        }
                    }
                } else if (quickWavBuf) {
                    const archNum = await getNextFileNumberStr(cleanArchive, 1);
                    await uploadWavBufferToExactPath(quickWavBuf, `ivr2:/${cleanArchive}/${archNum}.wav`, `${archNum}.wav`, 35000);
                }
            } catch (bgErr) {
                console.warn('[Background Full Video] Warning:', bgErr.message);
                if (validSegments.length === 0 && quickWavBuf) {
                    try {
                        await ensurePlayfileExtension(cleanArchive);
                        const archNum = await getNextFileNumberStr(cleanArchive, 1);
                        await uploadWavBufferToExactPath(quickWavBuf, `ivr2:/${cleanArchive}/${archNum}.wav`, `${archNum}.wav`, 35000);
                    } catch (e) {}
                }
            } finally {
                quickWavBuf = null;
                fs.promises.unlink(tmpFullIn).catch(() => null);
            }
        })();

        return chainedPlayCommand;

    } catch (e) {
        fs.promises.unlink(tmpQuickInput).catch(() => null);
        fs.promises.unlink(tmpQuickWav).catch(() => null);
        throw e;
    }
}

const MAIN_MENU_TEXT = 'ברוכים הבאים לחיפוש ביוטיוב! לשמיעת הפלייליסט שלכם הקישו 1 לשמיעת שיעורי התורה שלכם הקישו 2 לחיפוש מוזיקה חדש הקישו 3 לחיפוש שיעור חדש הקישו 4! שימו לב אם הסרטון ארוך מ 15 דקות הוא עולה בחלקים לשלוחת הפלייליסט או לשלוחת השיעורי תורה ! לחזרה לשלוחה הקודמת הקישו כוכבית! הקו מנוטר משתמש שיחפש תוכן לא ראוי יחסם ';

app.get('/', (req, res) => { res.send('YouTube Personal Line Server v33.0 (Dual YouTube API Key Fallback) OK'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        const callerPhone = lastVal(q.ApiPhone).replace(/[^0-9]/g, '');
        const callId = lastVal(q.ApiCallId);

        if (q.hangup === 'yes') {
            if (callerPhone) userSessionState.delete(callerPhone);
            return res.send('noop');
        }

        if (!callerPhone) {
            return res.send(`id_list_message=t-שגיאה בזיהוי מספר הטלפון&go_to_folder=${YOUTUBE_MAIN_EXT}`);
        }

        const hasMenuChoiceParam = (q.MenuChoice !== undefined);
        const menuChoice = lastVal(q.MenuChoice);
        const searchMusic = lastVal(q.SearchMusic);
        const searchTorah = lastVal(q.SearchTorah);
        const selectResult = lastVal(q.SelectResult);
        const recordName = lastVal(q.RecordName);

        const userFolder = `users/${callerPhone}`;
        const tempRecFolder = `users/${callerPhone}/temp`;
        const musicExtFolder = `1/${callerPhone}`;
        const torahExtFolder = `2/${callerPhone}`;

        let state = userSessionState.get(callerPhone);

        const hasAnyInputParams = Boolean(hasMenuChoiceParam || menuChoice || searchMusic || searchTorah || selectResult || recordName);
        if (!state || (callId && state.callId && state.callId !== callId) || !hasAnyInputParams) {
            const registeredName = await getUserNameIfRegistered(callerPhone);
            if (!registeredName) {
                userSessionState.set(callerPhone, { step: 'WAIT_NAME', callId });
                return res.send(`read=t-ברוכים הבאים אנא הקליטו את שמכם המלא ובסיום הקישו סולמית=RecordName,no,record,/${tempRecFolder},name_rec,no,7,1`);
            }
            userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
            return res.send(`read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
        }

        if (state.step === 'IN_PLAYLIST') {
            userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
            return res.send(`read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
        }

        // --- שלב א': תפריט התוצאות (1-7 להורדה, 8 לחיפוש מחדש, 9 לעוד תוצאות אחרות, 0 לתפריט) ---
        if (state.step === 'WAIT_SELECT_RESULT' && selectResult) {
            // מקש 8: חיפוש מחדש (הקלטה חדשה)
            if (selectResult === '8') {
                userSessionState.set(callerPhone, { step: 'WAIT_RECORD', isMusic: state.isMusic, callId });
                const recNum = await getNextFileNumberStr(tempRecFolder, 1);
                if (state.isMusic) {
                    return res.send(`read=t-אנא אמרו שוב את שם השיר המבוקש ובסיום הקישו סולמית=SearchMusic,no,record,/${tempRecFolder},${recNum},no,7,1`);
                } else {
                    return res.send(`read=t-אנא אמרו שוב את שם השיעור המבוקש ובסיום הקישו סולמית=SearchTorah,no,record,/${tempRecFolder},${recNum},no,7,1`);
                }
            }

            // מקש 9: מעבר ל-7 התוצאות הבאות ("עוד תוצאות אחרות")
            if (selectResult === '9') {
                const allResults = state.results || [];
                const currentPage = state.pageIndex || 0;
                const nextPage = ((currentPage + 1) * RESULTS_PER_PAGE < allResults.length) ? (currentPage + 1) : 0;

                const nextPromptText = buildPagePromptText(state.cleanQuery, allResults, nextPage);
                userSessionState.set(callerPhone, {
                    ...state,
                    pageIndex: nextPage,
                    menuPromptText: nextPromptText,
                    callId
                });

                return res.send(`read=t-${nextPromptText}=SelectResult,no,1,1,7,Digits,no`);
            }

            // מקש 0 / כוכבית / סולמית: חזרה לתפריט הראשי
            if (selectResult === '0' || selectResult === '*' || selectResult === '#') {
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
                return res.send(`read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
            }

            // מקשים 1 עד 7: בחירת התוצאה מתוך הדף הנוכחי
            const digitNum = parseInt(selectResult, 10);
            const allResults = state.results || [];
            const currentPage = state.pageIndex || 0;
            const pageStart = currentPage * RESULTS_PER_PAGE;
            const currentPageItems = allResults.slice(pageStart, pageStart + RESULTS_PER_PAGE);

            if (isNaN(digitNum) || digitNum < 1 || digitNum > currentPageItems.length) {
                return res.send(`id_list_message=t-בחירה שגויה&read=t-${state.menuPromptText}=SelectResult,no,1,1,7,Digits,no`);
            }

            const chosenVideo = currentPageItems[digitNum - 1];
            const { cleanQuery, isMusic } = state;
            const archiveFolder = isMusic ? musicExtFolder : torahExtFolder;
            const categoryLabel = isMusic ? 'מוזיקה' : 'שיעורים';
            const registeredName = (await getUserNameIfRegistered(callerPhone)) || 'משתמש רשום';

            try {
                const playCmd = await downloadAndPreparePlayback(chosenVideo.videoId, tempRecFolder, archiveFolder, chosenVideo.durationSeconds || 0);
                saveAdminLogToExt8(callerPhone, registeredName, categoryLabel, cleanQuery, chosenVideo.title, `הורד בהצלחה (דף ${currentPage + 1} תוצאה ${digitNum}) לשלוחה ${archiveFolder}`);
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });

                // הקראת שם הסרטון + אורכו רגע לפני תחילת ההשמעה
                const durationPart = chosenVideo.durationText ? ` באורך ${chosenVideo.durationText}` : '';
                return res.send(`id_list_message=t-משמיע ${chosenVideo.title}${durationPart}.${playCmd}&go_to_folder=${YOUTUBE_MAIN_EXT}`);
            } catch (audioErr) {
                console.error('[Download Error]', audioErr.message);
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
                return res.send(`id_list_message=t-נמצא ${chosenVideo.title} אך אירעה שגיאה בטעינת הקובץ&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
            }
        }

        // --- שלב ב': סיום הקלטת חיפוש -> תמלול + שליפת מאגר תוצאות מיוטיוב (בחלוקה ל-7 בכל דף) ---
        if (state.step === 'WAIT_RECORD' && (searchMusic || searchTorah)) {
            const isMusic = Boolean(state.isMusic);
            const recordPath = isMusic ? (searchMusic || searchTorah) : (searchTorah || searchMusic);
            const categoryLabel = isMusic ? 'מוזיקה' : 'שיעורים';
            const registeredName = (await getUserNameIfRegistered(callerPhone)) || 'משתמש רשום';

            let audioBuf;
            try {
                audioBuf = await downloadRecordingFromYemot(recordPath, lastVal(q.ApiExtension));
            } catch (dlErr) {
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
                return res.send(`id_list_message=t-שגיאה בהורדת ההקלטה&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
            }

            let rawText = '';
            try {
                rawText = await transcribeAudio(audioBuf.toString('base64'));
            } catch (gemErr) {
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
                return res.send(`id_list_message=t-שגיאה במנוע זיהוי הדיבור&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
            }

            const cleanQuery = sanitizeForYemotTts(rawText, 55);
            if (!cleanQuery) {
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
                return res.send(`id_list_message=t-לא הצלחתי לשמוע את הבקשה אנא נסו שנית&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
            }

            // מבקשים עד 28 תוצאות מיוטיוב (עם מעבר אוטומטי ל-YOUTUBE_API_KEY2 אם נגמרה המכסה בראשון)
            const ytBaseUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanQuery)}&type=video&maxResults=28`;
            let ytRes;
            let ytData;
            try {
                const ytResult = await fetchYouTubeWithFallback(ytBaseUrl, 6500);
                ytRes = ytResult.res;
                ytData = ytResult.data;
            } catch (ytFetchErr) {
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
                return res.send(`id_list_message=t-שגיאה בתקשורת עם יוטיוב&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
            }

            if (!ytRes || !ytRes.ok) {
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
                return res.send(`id_list_message=t-שגיאה במפתח החיפוש&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
            }

            const validItems = (ytData.items || [])
                .filter(item => item.id && item.id.videoId)
                .map(item => ({
                    videoId: item.id.videoId,
                    title: sanitizeForYemotTts(item.snippet?.title || cleanQuery, 52) || cleanQuery,
                    durationSeconds: 0,
                    durationText: ''
                }));

            if (validItems.length === 0) {
                saveAdminLogToExt8(callerPhone, registeredName, categoryLabel, cleanQuery, '', 'לא נמצאו תוצאות ביוטיוב');
                userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
                return res.send(`id_list_message=t-נקלט ${cleanQuery} לא נמצאו תוצאות ביוטיוב&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
            }

            // שליפת האורך של כל הסרטונים (עם תמיכה במעבר אוטומטי ל-YOUTUBE_API_KEY2)
            try {
                const idsList = validItems.map(v => v.videoId).join(',');
                const durBaseUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${encodeURIComponent(idsList)}`;
                const { res: durRes, data: durData } = await fetchYouTubeWithFallback(durBaseUrl, 5000);
                if (durRes && durRes.ok) {
                    const durMap = new Map();
                    for (const vItem of (durData.items || [])) {
                        if (vItem.id && vItem.contentDetails?.duration) {
                            durMap.set(vItem.id, parseIsoDurationToHebrew(vItem.contentDetails.duration));
                        }
                    }
                    for (const item of validItems) {
                        const dInfo = durMap.get(item.videoId);
                        if (dInfo) {
                            item.durationSeconds = dInfo.seconds;
                            item.durationText = dInfo.text;
                        }
                    }
                }
            } catch (durErr) {
                console.warn('[YouTube Duration Fetch Warning]', durErr.message);
            }

            const menuPromptText = buildPagePromptText(cleanQuery, validItems, 0);

            userSessionState.set(callerPhone, {
                step: 'WAIT_SELECT_RESULT',
                cleanQuery,
                isMusic,
                results: validItems,
                pageIndex: 0,
                menuPromptText,
                callId
            });

            return res.send(`read=t-${menuPromptText}=SelectResult,no,1,1,7,Digits,no`);
        }

        // --- שלב ג': בחירה בתפריט היוטיוב (1=פלייליסט, 2=שיעורים, 3=חיפוש שיר, 4=חיפוש שיעור, #=חזרה לשלוחה הקודמת) ---
        if (state.step === 'WAIT_MENU' && (hasMenuChoiceParam || menuChoice)) {
            if (menuChoice === '' || menuChoice === '#' || menuChoice === '*' || menuChoice === '0') {
                userSessionState.delete(callerPhone);
                return res.send('go_to_folder=..');
            }
            if (menuChoice === '1') {
                await ensurePlayfileExtension(musicExtFolder);
                userSessionState.set(callerPhone, { step: 'IN_PLAYLIST', callId });
                return res.send(`go_to_folder=/${musicExtFolder}`);
            }
            if (menuChoice === '2') {
                await ensurePlayfileExtension(torahExtFolder);
                userSessionState.set(callerPhone, { step: 'IN_PLAYLIST', callId });
                return res.send(`go_to_folder=/${torahExtFolder}`);
            }
            if (menuChoice === '3') {
                const recNum = await getNextFileNumberStr(tempRecFolder, 1);
                userSessionState.set(callerPhone, { step: 'WAIT_RECORD', isMusic: true, callId });
                return res.send(`read=t-אנא אמרו את שם השיר המבוקש ובסיום הקישו סולמית=SearchMusic,no,record,/${tempRecFolder},${recNum},no,7,1`);
            }
            if (menuChoice === '4') {
                const recNum = await getNextFileNumberStr(tempRecFolder, 1);
                userSessionState.set(callerPhone, { step: 'WAIT_RECORD', isMusic: false, callId });
                return res.send(`read=t-אנא אמרו את שם השיעור המבוקש ובסיום הקישו סולמית=SearchTorah,no,record,/${tempRecFolder},${recNum},no,7,1`);
            }
            userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
            return res.send(`read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
        }

        // --- שלב ד': הקלטת שם של משתמש חדש ---
        if (state.step === 'WAIT_NAME' && recordName) {
            let audioBuf;
            try {
                audioBuf = await downloadRecordingFromYemot(recordName, lastVal(q.ApiExtension));
            } catch (dlErr) {
                return res.send(`read=t-שגיאה בקליטת ההקלטה אנא הקליטו שוב את שמכם ובסיום הקישו סולמית=RecordName,no,record,/${tempRecFolder},name_rec,no,7,1`);
            }

            let rawName = '';
            try {
                rawName = await transcribeAudio(audioBuf.toString('base64'));
            } catch (e) {}
            const cleanName = sanitizeForYemotTts(rawName, 40) || 'משתמש רשום';

            await uploadWavBufferToExactPath(audioBuf, `ivr2:/${userFolder}/name.wav`, 'name.wav');
            await uploadTextToExactPath(cleanName, `ivr2:/${userFolder}/name.txt`, 'name.txt');
            userNamesCache.set(callerPhone, cleanName);

            await ensurePlayfileExtension(musicExtFolder);
            await ensurePlayfileExtension(torahExtFolder);

            saveAdminLogToExt8(callerPhone, cleanName, 'רישום למערכת', 'הקלטת שם משתמש', '', 'נרשם בהצלחה');

            userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
            return res.send(`id_list_message=t-שלום ${cleanName} נרשמתם בהצלחה&read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
        }

        userSessionState.set(callerPhone, { step: 'WAIT_MENU', callId });
        return res.send(`read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);

    } catch (e) {
        console.error('[General Error v33.0]', e.message);
        if (!res.headersSent) {
            return res.send(`read=t-${MAIN_MENU_TEXT}=MenuChoice,no,1,0,7,Digits,no`);
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v33.0 Ready on port ${port} ===`));
