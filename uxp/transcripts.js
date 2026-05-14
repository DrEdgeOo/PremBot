// Transcript module for PremBot.
//
// Two ingestion paths:
//   1. transcribeMediaFile(filePath)  - read a media file off disk via
//      UXP localFileSystem (we have fullAccess in the manifest), POST it
//      to OpenAI Whisper, store the returned segments in an in-memory
//      cache keyed by filePath.
//   2. (future) loadSRT(filePath)     - parse an .srt file already on
//      disk and stuff its segments into the same cache.
//
// Search and read tools then look up segments in the cache, regardless
// of which path produced them.

(function () {
    const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
    const cache = new Map(); // key: lowercased filePath, value: { segments, sourcePath, name }

    function normalizeKey(p) { return String(p).replace(/\\/g, "/").toLowerCase(); }
    function basename(p) {
        const m = String(p).replace(/\\/g, "/").split("/");
        return m[m.length - 1] || p;
    }

    function fileUrlFromPath(p) {
        // Windows: file:///C:/path  - UXP accepts forward slashes.
        let s = String(p).replace(/\\/g, "/");
        if (/^[a-zA-Z]:\//.test(s)) s = "/" + s;       // /C:/...
        else if (!s.startsWith("/")) s = "/" + s;
        return "file://" + s;
    }

    async function checkMediaFile(filePath) {
        const uxp = require("uxp");
        const fs = uxp.storage.localFileSystem;
        const formats = uxp.storage.formats;
        const url = fileUrlFromPath(filePath);
        try {
            const entry = await fs.getEntryWithUrl(url);
            // Read just enough to confirm we can access it.
            const data = await entry.read({ format: formats.binary });
            const sizeBytes = (data && data.byteLength) || 0;
            return {
                ok: true, exists: true, sourcePath: filePath, resolvedUrl: url,
                sizeBytes, sizeMB: +(sizeBytes / 1024 / 1024).toFixed(2),
                name: entry.name, isFile: !!entry.isFile,
                withinWhisperLimit: sizeBytes <= WHISPER_MAX_BYTES
            };
        } catch (e) {
            return {
                ok: false, exists: false, sourcePath: filePath, resolvedUrl: url,
                error: e && (e.message || String(e)),
                hint: "If the path looks right, open Windows Explorer and "
                    + "confirm the file actually exists. UXP needs an "
                    + "absolute path with backslashes or forward slashes, "
                    + "e.g. E:\\\\Video\\\\file.mp3 or E:/Video/file.mp3."
            };
        }
    }

    async function readFileAsBlob(filePath) {
        const uxp = require("uxp");
        const fs = uxp.storage.localFileSystem;
        const formats = uxp.storage.formats;
        const url = fileUrlFromPath(filePath);
        const entry = await fs.getEntryWithUrl(url);
        const data = await entry.read({ format: formats.binary });
        // entry.read returns an ArrayBuffer in binary format.
        const ext = (basename(filePath).split(".").pop() || "").toLowerCase();
        const mime = ext === "mp3" ? "audio/mpeg"
            : ext === "wav" ? "audio/wav"
            : ext === "m4a" ? "audio/mp4"
            : ext === "mp4" ? "video/mp4"
            : ext === "mov" ? "video/quicktime"
            : "application/octet-stream";
        return new Blob([data], { type: mime });
    }

    const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // OpenAI hard cap

    async function transcribeMediaFile(filePath, opts) {
        opts = opts || {};
        const key = normalizeKey(filePath);
        if (cache.has(key) && !opts.force) {
            const cached = cache.get(key);
            return { ok: true, cached: true, source: filePath,
                segmentCount: cached.segments.length };
        }
        const apiKey = opts.openaiKey;
        if (!apiKey) throw new Error("OpenAI API key not set in Settings.");

        const blob = await readFileAsBlob(filePath);
        if (blob.size > WHISPER_MAX_BYTES) {
            return {
                ok: false,
                error: "FILE_TOO_LARGE",
                fileSizeBytes: blob.size,
                fileSizeMB: +(blob.size / 1024 / 1024).toFixed(2),
                limitMB: 25,
                message: "Whisper rejects files over 25MB. Extract audio-"
                    + "only with FFmpeg first, e.g.:\n"
                    + "  ffmpeg -i \"" + filePath + "\" -vn -q:a 5 "
                    + "\"" + filePath.replace(/\.[^.\\/]+$/, "") + "_audio.mp3\"\n"
                    + "Then call transcribe_media_file on the .mp3."
            };
        }
        const formData = new FormData();
        formData.append("file", blob, basename(filePath));
        formData.append("model", opts.model || "whisper-1");
        formData.append("response_format", "verbose_json");
        // Adobe's transcript schema requires word-level timings, so we
        // ask Whisper for both granularities. The segments array is
        // still handy for our own search; the words array is what we
        // need to build a Premiere-shaped transcript.
        formData.append("timestamp_granularities[]", "segment");
        formData.append("timestamp_granularities[]", "word");
        if (opts.language) formData.append("language", opts.language);

        const res = await fetch(WHISPER_URL, {
            method: "POST",
            headers: { "Authorization": "Bearer " + apiKey },
            body: formData
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error("Whisper API " + res.status + ": " + text);
        }
        const json = await res.json();
        const segments = (json.segments || []).map((s) => ({
            startSec: s.start, endSec: s.end, text: (s.text || "").trim()
        }));
        const words = (json.words || []).map((w) => ({
            word: w.word, startSec: w.start, endSec: w.end
        }));
        cache.set(key, {
            sourcePath: filePath, name: basename(filePath),
            segments, words, fullText: json.text || "",
            duration: json.duration || null,
            language: json.language || null
        });
        return {
            ok: true, source: filePath, segmentCount: segments.length,
            durationSec: json.duration || null,
            firstSegment: segments[0] || null,
            lastSegment: segments[segments.length - 1] || null
        };
    }

    function listCachedTranscripts() {
        const out = [];
        for (const [, v] of cache) {
            out.push({ name: v.name, sourcePath: v.sourcePath,
                segmentCount: v.segments.length,
                durationSec: v.duration });
        }
        return out;
    }

    function getClipTranscript(filePathOrName) {
        const key = normalizeKey(filePathOrName);
        if (cache.has(key)) return cache.get(key);
        // Fallback: match by basename.
        const wanted = basename(filePathOrName).toLowerCase();
        for (const [, v] of cache) {
            if (v.name.toLowerCase() === wanted) return v;
        }
        return null;
    }

    // Format an SRT timestamp: 00:00:07,000
    function fmtSrtTime(sec) {
        if (typeof sec !== "number" || !isFinite(sec) || sec < 0) sec = 0;
        const ms  = Math.floor((sec - Math.floor(sec)) * 1000);
        const s   = Math.floor(sec) % 60;
        const m   = Math.floor(sec / 60) % 60;
        const h   = Math.floor(sec / 3600);
        const pad = (n, w) => String(n).padStart(w, "0");
        return pad(h, 2) + ":" + pad(m, 2) + ":" + pad(s, 2) + "," + pad(ms, 3);
    }

    function transcriptToSRT(segments) {
        const out = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            out.push(String(i + 1));
            out.push(fmtSrtTime(seg.startSec) + " --> " + fmtSrtTime(seg.endSec));
            out.push(seg.text || "");
            out.push("");
        }
        return out.join("\n");
    }

    function defaultSrtPathFor(sourcePath) {
        // Replace the source file's extension with .srt.
        const lastDot = sourcePath.lastIndexOf(".");
        if (lastDot > 0) return sourcePath.slice(0, lastDot) + ".srt";
        return sourcePath + ".srt";
    }

    // Write a string to an absolute path via UXP's localFileSystem.
    // We open the parent folder entry, then createFile on it.
    async function writeStringToPath(absPath, content) {
        const uxp = require("uxp");
        const fs = uxp.storage.localFileSystem;
        const norm = String(absPath).replace(/\\/g, "/");
        const lastSlash = norm.lastIndexOf("/");
        if (lastSlash < 0) {
            throw new Error("Output path must be absolute: " + absPath);
        }
        const dir = norm.slice(0, lastSlash + 1); // include trailing slash
        const name = norm.slice(lastSlash + 1);
        const dirUrl = fileUrlFromPath(dir);
        const folderEntry = await fs.getEntryWithUrl(dirUrl);
        const file = await folderEntry.createFile(name, { overwrite: true });
        await file.write(content);
        return file.nativePath || (dir + name);
    }

    async function saveTranscriptAsSRT(filePathOrName, outputPath) {
        const t = getClipTranscript(filePathOrName);
        if (!t) {
            return { ok: false, error: "NOT_TRANSCRIBED",
                message: "No cached transcript for \"" + filePathOrName
                + "\". Call transcribe_media_file first." };
        }
        const targetPath = outputPath || defaultSrtPathFor(t.sourcePath);
        const srt = transcriptToSRT(t.segments);
        const written = await writeStringToPath(targetPath, srt);
        return {
            ok: true, source: t.sourcePath, srtPath: written,
            segmentCount: t.segments.length, bytes: srt.length,
            hint: "Drag the .srt file from Windows Explorer into Premiere's "
                + "Project panel. Premiere imports it as a caption clip; "
                + "drop it on a Caption track to display as captions."
        };
    }

    function searchTranscripts(query, opts) {
        opts = opts || {};
        const maxResults = opts.maxResults || 25;
        const q = String(query || "").trim().toLowerCase();
        if (!q) return { results: [], note: "empty query" };
        const hits = [];
        for (const [, v] of cache) {
            for (const seg of v.segments) {
                const idx = seg.text.toLowerCase().indexOf(q);
                if (idx >= 0) {
                    hits.push({
                        clip: v.name, sourcePath: v.sourcePath,
                        startSec: seg.startSec, endSec: seg.endSec,
                        text: seg.text
                    });
                    if (hits.length >= maxResults) break;
                }
            }
            if (hits.length >= maxResults) break;
        }
        return { query: q, results: hits, totalCachedClips: cache.size };
    }

    // ---- Adobe transcript schema converter + Premiere import ----
    //
    // Schema: https://schemas.adobe.com/transcript/v1.0.0 (downloaded
    // from the AdobeDocs/uxp-premiere-pro-samples repo). Strict shape:
    //   { language, segments[], speakers[] }
    // Every Word requires: confidence, duration, eos, start, tags, text, type.

    // Map Whisper / common locale strings to Adobe's enum.
    function toAdobeLang(whisperLang) {
        if (!whisperLang) return "en-us";
        const k = String(whisperLang).toLowerCase();
        const m = {
            english: "en-us", en: "en-us", "en-us": "en-us", "en-gb": "en-gb",
            spanish: "es-es", es: "es-es", german: "de-de", de: "de-de",
            french: "fr-fr", fr: "fr-fr", japanese: "ja-jp", ja: "ja-jp",
            portuguese: "pt-pt", pt: "pt-pt", korean: "ko-kr", ko: "ko-kr",
            italian: "it-it", it: "it-it", russian: "ru-ru", ru: "ru-ru",
            hindi: "hi-in", hi: "hi-in", dutch: "nl-nl", nl: "nl-nl",
            danish: "da-dk", indonesian: "id-id", thai: "th-th",
            vietnamese: "vi-vn", malay: "ms-my", turkish: "tr-tr",
            polish: "pl-pl"
        };
        return m[k] || "??-??";
    }

    function uuidV4() {
        const r = (n) => {
            const buf = new Uint8Array(n);
            (globalThis.crypto || require("crypto")).getRandomValues(buf);
            return buf;
        };
        const b = r(16);
        b[6] = (b[6] & 0x0f) | 0x40;     // version 4
        b[8] = (b[8] & 0x3f) | 0x80;     // variant
        const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
        return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-"
            + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    }

    // Whisper sometimes returns word entries with duration:0 sharing
    // a start time with the next word. Adobe's schema permits
    // duration:0, but Premiere's runtime appears to reject the import
    // when timings aren't strictly monotonic + positive. Clamp each
    // word to a minimum duration and bump any start that isn't past
    // the previous word's start.
    const MIN_WORD_DUR = 0.01;
    const MIN_WORD_GAP = 0.001;
    function normalizeWords(words) {
        if (!words || !words.length) return [];
        const sorted = words.slice().sort((a, b) => a.start - b.start);
        const out = [];
        for (let i = 0; i < sorted.length; i++) {
            const src = sorted[i];
            const w = {
                confidence: src.confidence, duration: src.duration,
                eos: src.eos, start: src.start, tags: src.tags || [],
                text: src.text, type: src.type
            };
            if (!(w.duration > 0)) w.duration = MIN_WORD_DUR;
            if (i > 0) {
                const prev = out[out.length - 1];
                const minStart = prev.start + MIN_WORD_GAP;
                if (w.start < minStart) w.start = minStart;
            }
            out.push(w);
        }
        return out;
    }

    // Convert our cached Whisper result to Adobe's strict JSON shape.
    // Word-level timings are required; if Whisper didn't return any
    // (older cached entries), we fall back to one synthetic word per
    // segment - works but loses word-level granularity.
    function toAdobeTranscriptJSON(cached, speakerName) {
        const speakerId = uuidV4();
        const language = toAdobeLang(cached.language);
        const out = {
            language,
            segments: [],
            speakers: [{ id: speakerId, name: speakerName || "Speaker 1" }]
        };

        const PUNCT_ONLY = /^[\s\p{P}]+$/u;

        const allWords = (cached.words || []).filter(
            (w) => w && typeof w.startSec === "number"
                && typeof w.endSec === "number" && w.word);

        // Bucket words into segments by overlap with segment start/end.
        for (const seg of (cached.segments || [])) {
            const segWords = allWords.filter(
                (w) => w.startSec >= seg.startSec - 0.0001
                    && w.endSec   <= seg.endSec + 0.0001);
            const rawWords = segWords.length > 0
                ? segWords.map((w, idx) => {
                    const text = w.word;
                    const isPunct = PUNCT_ONLY.test(text);
                    const isLast = idx === segWords.length - 1;
                    return {
                        confidence: 1.0,
                        duration: Math.max(0, w.endSec - w.startSec),
                        eos: isLast,
                        start: w.startSec,
                        tags: [],
                        text,
                        type: isPunct ? "punctuation" : "word"
                    };
                })
                : [{
                    confidence: 1.0,
                    duration: Math.max(MIN_WORD_DUR, seg.endSec - seg.startSec),
                    eos: true,
                    start: seg.startSec,
                    tags: [],
                    text: seg.text,
                    type: "word"
                }];
            const wordsArr = normalizeWords(rawWords);
            out.segments.push({
                duration: Math.max(MIN_WORD_DUR, seg.endSec - seg.startSec),
                language,
                speaker: speakerId,
                start: seg.startSec,
                words: wordsArr
            });
        }

        // If we somehow have no segments at all but do have words, fold
        // every word into one segment so the schema's minItems: 1 holds.
        if (out.segments.length === 0 && allWords.length > 0) {
            const start = allWords[0].startSec;
            const end = allWords[allWords.length - 1].endSec;
            const rawWords = allWords.map((w, idx) => ({
                confidence: 1.0,
                duration: Math.max(0, w.endSec - w.startSec),
                eos: idx === allWords.length - 1,
                start: w.startSec, tags: [], text: w.word, type: "word"
            }));
            out.segments.push({
                duration: Math.max(MIN_WORD_DUR, end - start),
                language, speaker: speakerId, start,
                words: normalizeWords(rawWords)
            });
        }
        return out;
    }

    // Push the cached transcript into Premiere using the canonical
    // pattern from the skill's transcripts.md.
    async function pushTranscriptToPremiere(filePathOrName, clipNameInBin,
                                            opts) {
        opts = opts || {};
        const ppro = require("premierepro");
        const cached = getClipTranscript(filePathOrName);
        if (!cached) {
            return { ok: false, error: "NOT_TRANSCRIBED",
                message: "No cached transcript for \"" + filePathOrName
                + "\". Call transcribe_media_file first." };
        }
        const project = await ppro.Project.getActiveProject();
        if (!project) throw new Error("No project open");
        const root = await project.getRootItem();
        const items = await root.getItems();

        // Walk the bin tree to find a ClipProjectItem whose name matches.
        async function findByName(parent, target) {
            const subItems = await parent.getItems();
            for (const it of subItems) {
                const isFolder = typeof it.getItems === "function"
                    && !(ppro.ClipProjectItem
                        && it instanceof ppro.ClipProjectItem);
                if (isFolder) {
                    const hit = await findByName(it, target);
                    if (hit) return hit;
                } else if (it.name === target) {
                    return it;
                }
            }
            return null;
        }
        const wantedName = clipNameInBin || cached.name;
        let clipItem = await findByName(root, wantedName);
        // Fallback: case-insensitive basename match
        if (!clipItem) {
            const lower = wantedName.toLowerCase();
            async function loose(parent) {
                const sub = await parent.getItems();
                for (const it of sub) {
                    if (typeof it.getItems === "function"
                        && !(ppro.ClipProjectItem
                            && it instanceof ppro.ClipProjectItem)) {
                        const hit = await loose(it);
                        if (hit) return hit;
                    } else if (it.name
                        && it.name.toLowerCase() === lower) {
                        return it;
                    }
                }
                return null;
            }
            clipItem = await loose(root);
        }
        if (!clipItem) {
            return { ok: false, error: "CLIP_NOT_IN_BIN",
                message: "No bin item named \"" + wantedName + "\". "
                    + "Pass clipNameInBin explicitly if the bin name differs "
                    + "from the audio file name." };
        }

        // The transcript API specifically requires a ClipProjectItem.
        // root.getItems() returns base ProjectItem wrappers in this
        // build, so use Adobe's canonical upcast (castOrThrow returns
        // a properly typed instance or throws if the item isn't a
        // clip).
        const clipCtorBefore = clipItem.constructor && clipItem.constructor.name;
        let castedClip = clipItem;
        let castMethod = "none";
        if (ppro.ClipProjectItem) {
            if (typeof ppro.ClipProjectItem.castOrThrow === "function") {
                try {
                    castedClip = ppro.ClipProjectItem.castOrThrow(clipItem);
                    castMethod = "castOrThrow";
                } catch (e) {
                    return { ok: false, error: "NOT_A_CLIP_PROJECT_ITEM",
                        message: "Selected bin item is not a ClipProjectItem: "
                            + (e && (e.message || String(e))),
                        clipName: clipItem.name, clipCtor: clipCtorBefore };
                }
            } else if (typeof ppro.ClipProjectItem.queryCast === "function") {
                const cast = ppro.ClipProjectItem.queryCast(clipItem);
                if (cast) { castedClip = cast; castMethod = "queryCast"; }
            }
        }

        const adobeTranscript = toAdobeTranscriptJSON(cached,
            opts.speakerName);
        const jsonString = JSON.stringify(adobeTranscript);

        let textSegments;
        try {
            textSegments = await ppro.Transcript.importFromJSON(jsonString);
        } catch (e) {
            return { ok: false, error: "PARSE_FAILED",
                message: "Transcript.importFromJSON rejected the JSON: "
                    + (e && (e.message || String(e))),
                jsonHead: jsonString.slice(0, 600) };
        }
        if (!textSegments) {
            return { ok: false, error: "PARSE_NULL",
                jsonHead: jsonString.slice(0, 600),
                message: "importFromJSON returned null/undefined." };
        }

        const ctx = {
            clipName: clipItem.name,
            clipCtorBefore,
            clipCtorAfter: castedClip.constructor && castedClip.constructor.name,
            castMethod,
            segmentCount: adobeTranscript.segments.length,
            wordCount: adobeTranscript.segments
                .reduce((n, s) => n + s.words.length, 0),
            language: adobeTranscript.language,
            jsonHead: jsonString.slice(0, 800),
            firstSegmentSample: adobeTranscript.segments[0] || null
        };

        let action;
        try {
            action = await ppro.Transcript
                .createImportTextSegmentsAction(textSegments, castedClip);
        } catch (e) {
            return Object.assign({
                ok: false, error: "ACTION_FACTORY_FAILED",
                message: "createImportTextSegmentsAction threw: "
                    + (e && (e.message || String(e)))
            }, ctx);
        }
        if (!action) {
            return Object.assign({
                ok: false, error: "ACTION_NULL",
                message: "createImportTextSegmentsAction returned null/undefined."
            }, ctx);
        }

        try {
            project.lockedAccess(() => {
                project.executeTransaction((c) => c.addAction(action),
                    "PremBot: import transcript for " + clipItem.name);
            });
        } catch (txErr) {
            return Object.assign({
                ok: false, error: "DISPATCH_FAILED",
                message: txErr && (txErr.message || String(txErr))
            }, ctx);
        }

        return Object.assign({
            ok: true,
            note: "Transcript attached to the bin clip. Open Window > Text > "
                + "Transcript in Premiere; you should see the new transcript "
                + "selected. From there, Create Captions to push to a "
                + "Caption track (still a UI step in this Premiere build)."
        }, ctx);
    }

    globalThis.PremBotTranscripts = {
        transcribeMediaFile,
        checkMediaFile,
        listCachedTranscripts,
        getClipTranscript,
        searchTranscripts,
        saveTranscriptAsSRT,
        pushTranscriptToPremiere,
        _cacheSize: () => cache.size
    };
})();
