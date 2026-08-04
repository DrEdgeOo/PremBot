// Per-extension persistent storage. Keys + transcript cache live in the panel's
// userData dir so they survive panel reloads but never leak into a git repo.
var Storage = (function () {
    var fs   = (typeof require === 'function') ? require('fs')   : null;
    var path = (typeof require === 'function') ? require('path') : null;
    var os   = (typeof require === 'function') ? require('os')   : null;

    function _dir() {
        if (!fs) return null;
        var root = (os && os.homedir) ? os.homedir() : process.env.HOME || '.';
        var dir  = path.join(root, '.prembot');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        return dir;
    }
    function _file(name) { return path.join(_dir(), name); }

    function loadJSON(name, fallback) {
        try {
            if (fs && fs.existsSync(_file(name))) {
                return JSON.parse(fs.readFileSync(_file(name), 'utf8'));
            }
        } catch (e) { console.warn('Storage.loadJSON', name, e); }
        return fallback;
    }
    function saveJSON(name, value) {
        try { fs.writeFileSync(_file(name), JSON.stringify(value, null, 2), 'utf8'); }
        catch (e) { console.warn('Storage.saveJSON', name, e); }
    }

    var DEFAULT_STYLE =
        "House editing style:\n" +
        "- Open with a strong hook in the first 3 seconds.\n" +
        "- Cut filler words and long pauses (>0.6s).\n" +
        "- Vary shot length; favor 2-5s clips for energy.\n" +
        "- Hold beats on emotional or punchline moments.\n" +
        "- Prefer hard cuts over transitions unless changing scene.\n";

    return {
        getSettings: function () {
            return loadJSON('settings.json', {
                anthropicKey:  '',
                openaiKey:     '',
                model:         'claude-sonnet-4-6',
                styleProfile:  DEFAULT_STYLE
            });
        },
        saveSettings: function (s) { saveJSON('settings.json', s); },

        getTranscripts: function () { return loadJSON('transcripts.json', {}); },
        saveTranscripts: function (t) { saveJSON('transcripts.json', t); }
    };
})();
