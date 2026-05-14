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
        formData.append("timestamp_granularities[]", "segment");
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
        cache.set(key, {
            sourcePath: filePath, name: basename(filePath),
            segments, fullText: json.text || "",
            duration: json.duration || null
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

    globalThis.PremBotTranscripts = {
        transcribeMediaFile,
        listCachedTranscripts,
        getClipTranscript,
        searchTranscripts,
        _cacheSize: () => cache.size
    };
})();
