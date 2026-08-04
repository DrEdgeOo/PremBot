// Transcribe a media file via OpenAI Whisper. Returns { language, duration, segments }
// where segments = [{ start, end, text }]. We send the raw media file; Whisper extracts
// audio internally. Max file size 25MB — bigger clips are flagged for the user to chunk
// upstream (a real product would ship ffmpeg + chunking; out of scope for MVP).
var Transcribe = (function () {
    var fs = (typeof require === 'function') ? require('fs') : null;
    var path = (typeof require === 'function') ? require('path') : null;

    var WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
    var MAX_BYTES   = 25 * 1024 * 1024;

    async function file(filePath, apiKey) {
        if (!fs) throw new Error('Node fs unavailable — is --enable-nodejs set?');
        if (!apiKey) throw new Error('OpenAI API key missing (Settings tab).');
        if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);

        var stat = fs.statSync(filePath);
        if (stat.size > MAX_BYTES) {
            throw new Error('File >25MB (Whisper limit). Trim or pre-export audio: ' + path.basename(filePath));
        }

        var buf  = fs.readFileSync(filePath);
        var blob = new Blob([buf], { type: 'application/octet-stream' });

        var form = new FormData();
        form.append('file',            blob, path.basename(filePath));
        form.append('model',           'whisper-1');
        form.append('response_format', 'verbose_json');
        form.append('timestamp_granularities[]', 'segment');

        var res = await fetch(WHISPER_URL, {
            method:  'POST',
            headers: { 'Authorization': 'Bearer ' + apiKey },
            body:    form
        });
        if (!res.ok) {
            var t = await res.text();
            throw new Error('Whisper ' + res.status + ': ' + t);
        }
        var json = await res.json();
        return {
            language: json.language,
            duration: json.duration,
            segments: (json.segments || []).map(function (s) {
                return { start: s.start, end: s.end, text: (s.text || '').trim() };
            }),
            text:     json.text
        };
    }

    return { file: file };
})();
