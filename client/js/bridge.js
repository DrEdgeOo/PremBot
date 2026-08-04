// PremBot CEP Helper - localhost HTTP bridge.
//
// Lives inside a CEP panel so it can both (a) call ExtendScript via
// CSInterface and (b) run a Node HTTP server (CEP's runtime ships Node).
// The UXP panel posts to http://127.0.0.1:53210/exec/:tool with JSON
// args; we evalScript a matching JSX function and return the result.
//
// Port is the FIXED 53210 (HELPER_PORT below), bound to 127.0.0.1 only.
// There is no port discovery here - an earlier design used a random
// OS-assigned port and this comment used to describe it; don't go
// looking for that logic.
//
// We still write a status file:
//   %APPDATA%\PremBot\helper-status.json (Windows)
//   ~/Library/Application Support/PremBot/helper-status.json (macOS)
// It is the liveness signal the UXP panel watches (deleted on panel
// close). getPort() in uxp/helper-client.js honors whatever port the
// file reports, but that is always 53210 today, and it falls back to
// 53210 when the file is absent - so getPort() can never return falsy
// and its `if (!port)` guards are dead code. Changing the port for
// real also means updating the UXP manifest's network permission.

(function () {
    var csi = new CSInterface();
    var http  = require("http");
    var fs    = require("fs");
    var os    = require("os");
    var path  = require("path");
    var spawn = require("child_process").spawn;
    var crypto = require("crypto");

    var $ = function (id) { return document.getElementById(id); };

    function log(msg) {
        var el = $("log");
        var line = "[" + new Date().toLocaleTimeString() + "] " + msg;
        el.textContent += (el.textContent ? "\n" : "") + line;
        el.scrollTop = el.scrollHeight;
    }

    function appDataDir() {
        // Cross-platform: AppData on Windows, Library/Application Support on macOS.
        if (process.platform === "win32") {
            return path.join(process.env.APPDATA || os.homedir(), "PremBot");
        }
        return path.join(os.homedir(), "Library", "Application Support", "PremBot");
    }

    function ensureDir(p) {
        if (!fs.existsSync(p)) {
            fs.mkdirSync(p, { recursive: true });
        }
    }

    function writeStatus(obj) {
        var dir = appDataDir();
        ensureDir(dir);
        var statusPath = path.join(dir, "helper-status.json");
        fs.writeFileSync(statusPath, JSON.stringify(obj, null, 2));
        $("status-file").textContent = statusPath;
        return statusPath;
    }

    function evalAsync(jsxCall) {
        return new Promise(function (resolve) {
            csi.evalScript(jsxCall, function (raw) {
                if (raw === "EvalScript error.") {
                    return resolve({ ok: false, error: "EVAL_SCRIPT_ERROR" });
                }
                var parsed;
                try { parsed = JSON.parse(raw); }
                catch (e) { parsed = { ok: false, error: "BAD_JSON",
                    raw: String(raw).slice(0, 500) }; }
                resolve(parsed);
            });
        });
    }

    function jsxCall(toolName, argsObj) {
        // Pass args through pbRun(toolName, jsonString) on the ExtendScript
        // side. JSON-stringify here, parse on the JSX side.
        var s = JSON.stringify(argsObj || {});
        // Escape backslashes and single quotes for embedding in a JSX literal.
        s = s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        return "pbRun(" + JSON.stringify(toolName) + ", '" + s + "')";
    }

    function readBody(req) {
        return new Promise(function (resolve, reject) {
            var chunks = [];
            req.on("data", function (c) { chunks.push(c); });
            req.on("end", function () {
                var s = Buffer.concat(chunks).toString("utf8");
                if (!s) return resolve({});
                try { resolve(JSON.parse(s)); }
                catch (e) { reject(new Error("Invalid JSON body")); }
            });
            req.on("error", reject);
        });
    }

    function send(res, status, body) {
        res.writeHead(status, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        });
        res.end(JSON.stringify(body));
    }

    // Node-side tool handlers - these short-circuit before the
    // ExtendScript dispatch because they need Node APIs (child_process,
    // streams, etc.) that ExtendScript can't reach.
    //
    // extract_wav: spawn ffmpeg to decode an MP3/M4A/anything-ffmpeg-
    // can-read into mono 22.05kHz WAV. UXP's OfflineAudioContext is
    // unavailable on Premiere 26.2.2, so the UXP audio module dead-
    // ends on non-WAV files; this handler closes that gap.
    //
    // librosa_beat_track: spawn python beat_track.py for professional
    // beat tracking via librosa.beat.beat_track (DP-based, spectral
    // flux, much better than our hand-rolled energy-difference
    // detector). Used as the primary path; the JS detector stays as
    // a fallback when Python or librosa isn't installed.
    //
    // librosa_drum_detect: spawn python drum_detect.py for per-
    // instrument onset detection (kick / snare / hi-hat) via scipy
    // bandpass + librosa.onset.onset_detect. No JS fallback - this
    // is a librosa-only feature; if Python isn't installed the
    // helper returns LIBROSA_NOT_INSTALLED so the UXP agent can
    // surface the install hint.
    var NODE_HANDLERS = {
        extract_wav: extractWav,
        librosa_beat_track: librosaBeatTrack,
        librosa_drum_detect: librosaDrumDetect,
        demucs_separate: demucsSeparate,
        analyze_clip: visionAnalyzeClip
    };

    function audioCacheDir() {
        var d = path.join(os.tmpdir(), "PremBot-audio-cache");
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        return d;
    }

    function hashPath(p) {
        return crypto.createHash("sha1").update(String(p)).digest("hex")
            .slice(0, 16);
    }

    // Cache files keyed by source-path hash + source mtime. mtime is
    // included so the cache invalidates if the source file is updated.
    function cacheWavPathFor(srcPath) {
        var st;
        try { st = fs.statSync(srcPath); } catch (e) { return null; }
        var key = hashPath(srcPath) + "-" + Math.floor(st.mtimeMs);
        return path.join(audioCacheDir(), key + ".wav");
    }

    function findFfmpegSync() {
        // Try a quick spawn-and-check on PATH. spawnSync is cleaner
        // but we already imported spawn; use a one-shot wrapper.
        return new Promise(function (resolve) {
            try {
                var p = spawn("ffmpeg", ["-version"], { windowsHide: true });
                var seen = false;
                p.on("error", function () {
                    if (!seen) { seen = true; resolve(null); }
                });
                p.on("close", function (code) {
                    if (!seen) { seen = true; resolve(code === 0 ? "ffmpeg" : null); }
                });
            } catch (e) { resolve(null); }
        });
    }

    async function extractWav(args) {
        var srcPath = args && args.srcPath;
        if (!srcPath) return { ok: false, error: "MISSING_SRC_PATH" };
        if (!fs.existsSync(srcPath)) {
            return { ok: false, error: "SRC_NOT_FOUND", srcPath: srcPath };
        }
        var dstPath = args.dstPath || cacheWavPathFor(srcPath);
        if (!dstPath) return { ok: false, error: "CACHE_PATH_FAILED" };

        // Reuse cached extraction when possible.
        if (fs.existsSync(dstPath)) {
            return { ok: true, wavPath: dstPath, cached: true };
        }
        var ffmpeg = await findFfmpegSync();
        if (!ffmpeg) {
            return { ok: false, error: "FFMPEG_NOT_FOUND",
                message: "ffmpeg not on PATH. Install it from "
                    + "https://ffmpeg.org/download.html and ensure "
                    + "'ffmpeg' resolves from a terminal, then retry. "
                    + "Alternatively, extract the WAV manually:\n"
                    + "  ffmpeg -i \"" + srcPath + "\" -ac 1 -ar 22050 "
                    + "\"" + dstPath + "\"\n"
                    + "and pass filePath directly to detect_beats.",
                suggestedWavPath: dstPath };
        }
        var sr = args.sampleRate || 22050;
        var ch = args.channels   || 1;
        log("ffmpeg -> " + path.basename(dstPath));
        var result = await new Promise(function (resolve) {
            var stderr = "";
            try {
                var p = spawn(ffmpeg, [
                    "-y", "-loglevel", "error",
                    "-i", srcPath,
                    "-ac", String(ch),
                    "-ar", String(sr),
                    dstPath
                ], { windowsHide: true });
                p.stderr.on("data", function (d) {
                    stderr += String(d);
                });
                p.on("error", function (e) {
                    resolve({ ok: false, error: "FFMPEG_SPAWN_ERROR",
                        message: e.message || String(e) });
                });
                p.on("close", function (code) {
                    if (code === 0 && fs.existsSync(dstPath)) {
                        var sz = 0;
                        try { sz = fs.statSync(dstPath).size; } catch (e) {}
                        resolve({ ok: true, wavPath: dstPath,
                            cached: false, sizeBytes: sz,
                            sampleRate: sr, channels: ch });
                    } else {
                        resolve({ ok: false, error: "FFMPEG_FAILED",
                            exitCode: code, stderr: stderr.slice(0, 2000) });
                    }
                });
            } catch (e) {
                resolve({ ok: false, error: "FFMPEG_SPAWN_THREW",
                    message: e.message || String(e) });
            }
        });
        return result;
    }

    // Locate the Python beat-tracker script. The CEP extension lives
    // under %APPDATA%\Adobe\CEP\extensions\PremBot\ once installed by
    // install-windows.bat (which copies client/, host/, CSXS/). The
    // python script ships inside client/python/ so robocopy /MIR
    // brings it along. csi.getSystemPath("extension") returns the
    // extension root regardless of install path.
    // Resolve a CEP-supplied path string into a Node-readable path.
    // Different CEP builds return:
    //   - "C:\\Users\\...\\PremBot"           (Windows native)
    //   - "/Users/.../PremBot"                (POSIX)
    //   - "file:///C:/Users/.../PremBot"      (file URL, seen on some
    //                                          Premiere 26.x builds)
    //   - "file:///Users/.../PremBot"         (macOS file URL)
    // Strip the file:// prefix when present; otherwise pass through.
    function normalizeCepPath(p) {
        if (!p) return p;
        p = String(p);
        if (p.indexOf("file:///") === 0) {
            // Windows: "file:///C:/foo" -> "C:/foo"
            // POSIX:   "file:///foo"    -> "/foo"
            var stripped = p.substring(8);
            if (/^[a-zA-Z]:/.test(stripped)) return stripped;
            return "/" + stripped;
        }
        if (p.indexOf("file://") === 0) return p.substring(7);
        return p;
    }

    // Try every plausible location for a Python script under
    // client/python/. CEP path APIs vary across versions/hosts, so
    // we don't trust any single source. Returns { path, source,
    // candidates } - source identifies which candidate landed,
    // candidates is the full list with existence flags so the
    // SCRIPT_MISSING error can show the user every place we looked.
    function findPythonScript(scriptName) {
        var candidates = [];
        function add(label, raw) {
            if (!raw) return;
            var normalized = normalizeCepPath(raw);
            var full = path.join(normalized, "client", "python",
                scriptName);
            candidates.push({ source: label, raw: raw,
                tried: full, exists: false });
        }
        try { add("csi.getSystemPath('extension')",
            csi.getSystemPath && csi.getSystemPath("extension")); } catch (e) {}
        try { add("csi.getSystemPath('extensions')",
            csi.getSystemPath && csi.getSystemPath("extensions")); } catch (e) {}
        // bridge.js lives at <ext>/client/js/bridge.js, so walking up
        // two and adding python/ hits the same target without CEP at all.
        try { add("__dirname-relative",
            path.resolve(__dirname, "..")); } catch (e) {}
        // Last-ditch: the known per-user install path. install-windows.
        // bat hardcodes this, so on Windows it's reliable.
        try {
            if (process.platform === "win32" && process.env.APPDATA) {
                add("APPDATA-fallback",
                    path.join(process.env.APPDATA, "Adobe", "CEP",
                        "extensions", "PremBot"));
            }
        } catch (e) {}

        for (var i = 0; i < candidates.length; i++) {
            try {
                if (fs.existsSync(candidates[i].tried)) {
                    candidates[i].exists = true;
                    return { path: candidates[i].tried,
                        source: candidates[i].source,
                        candidates: candidates };
                }
            } catch (e) {}
        }
        return { path: null, source: null, candidates: candidates };
    }

    // Resolve the Python interpreter to spawn sidecars with. Cached
    // after first probe.
    //
    // Resolution order:
    //   1. PREMBOT_PYTHON env var - an absolute path or command name.
    //      Escape hatch when auto-detection picks the wrong Python on
    //      multi-interpreter machines (very common on Windows).
    //   2. "py -3" (Windows py launcher). On Windows the py launcher
    //      resolves the same interpreter pip writes to, side-stepping
    //      the Microsoft Store Python stub at the head of PATH.
    //   3. "python" - the Windows installer's default executable name.
    //   4. "python3" - typical on Unix / macOS.
    //
    // We probe with -c "import sys" rather than --version so we know
    // the interpreter can actually run code (the MS Store stub
    // sometimes prints a version then exits non-zero on real imports).
    var cachedPython = null;
    var cachedPythonExe = null;
    function findPython() {
        if (cachedPython) return Promise.resolve(cachedPython);
        return new Promise(function (resolve) {
            function tryCmd(cmdArr, next) {
                try {
                    var argv = cmdArr.slice(1).concat(
                        ["-c", "import sys; print(sys.executable)"]);
                    var p = spawn(cmdArr[0], argv, { windowsHide: true });
                    var stdout = "", done = false;
                    p.stdout.on("data", function (d) { stdout += String(d); });
                    p.on("error", function () {
                        if (done) return; done = true; next();
                    });
                    p.on("close", function (code) {
                        if (done) return; done = true;
                        if (code === 0) {
                            cachedPython = cmdArr.join(" ");
                            cachedPythonExe = stdout.trim();
                            resolve(cachedPython);
                        } else next();
                    });
                } catch (e) { next(); }
            }
            var override = process.env && process.env.PREMBOT_PYTHON;
            var chain = [];
            if (override) chain.push([override]);
            if (process.platform === "win32") chain.push(["py", "-3"]);
            chain.push(["python"]);
            chain.push(["python3"]);
            (function step(i) {
                if (i >= chain.length) return resolve(null);
                tryCmd(chain[i], function () { step(i + 1); });
            }(0));
        });
    }

    // Returns the absolute path of the python.exe the helper resolved.
    // Used to enrich "module not installed" errors so the user can see
    // WHICH python they need to pip-install into.
    function resolvedPythonExe() { return cachedPythonExe; }

    // Split a resolved command string ("py -3" or "python") into
    // (executable, prefixArgs) so spawn() works for both forms.
    function splitPythonCmd(cmd) {
        var parts = String(cmd).split(/\s+/).filter(Boolean);
        return { exe: parts[0], prefix: parts.slice(1) };
    }

    // Convenience: spawn the resolved python with [prefix...] +
    // scriptArgs. Returns the spawned child so callers can wire
    // stdout / stderr / close handlers themselves.
    function spawnPython(scriptArgs) {
        var pc = splitPythonCmd(cachedPython);
        return spawn(pc.exe, pc.prefix.concat(scriptArgs),
            { windowsHide: true });
    }

    async function librosaBeatTrack(args) {
        var src = args && args.srcPath;
        if (!src) return { ok: false, error: "MISSING_SRC_PATH" };
        if (!fs.existsSync(src)) {
            return { ok: false, error: "SRC_NOT_FOUND", srcPath: src };
        }
        var pythonCmd = await findPython();
        if (!pythonCmd) {
            return { ok: false, error: "PYTHON_NOT_FOUND",
                message: "python / python3 not on PATH. Install Python "
                    + "3.8+ from https://www.python.org/downloads/ and "
                    + "ensure it resolves in a terminal, then reopen "
                    + "the PremBot Helper panel." };
        }
        var lookup = findPythonScript("beat_track.py");
        if (!lookup.path) {
            return { ok: false, error: "SCRIPT_MISSING",
                candidates: lookup.candidates,
                message: "beat_track.py not found in any of "
                    + lookup.candidates.length + " probed locations. "
                    + "Re-run install-windows.bat OR pass an absolute "
                    + "filePath directly. Candidates checked: "
                    + lookup.candidates.map(function (c) {
                        return c.source + " -> " + c.tried;
                    }).join("  |  ") };
        }
        var scriptPath = lookup.path;
        log("script via " + lookup.source);
        var maxBeats = (args && args.maxBeats) || 256;
        var bpmHint  = (args && args.bpmHint) || 0;
        log("librosa <- " + path.basename(src)
            + (bpmHint ? " (hint=" + bpmHint + " BPM)" : ""));
        return await new Promise(function (resolve) {
            var stdout = "", stderr = "";
            try {
                var p = spawnPython(
                    [scriptPath, src, String(maxBeats),
                     bpmHint ? String(bpmHint) : "0"]);
                p.stdout.on("data", function (d) { stdout += String(d); });
                p.stderr.on("data", function (d) { stderr += String(d); });
                p.on("error", function (e) {
                    resolve({ ok: false, error: "PYTHON_SPAWN_ERROR",
                        message: e.message || String(e) });
                });
                p.on("close", function (code) {
                    var trimmed = stdout.trim();
                    if (trimmed) {
                        try {
                            var parsed = JSON.parse(trimmed);
                            return resolve(parsed);
                        } catch (e) {
                            return resolve({ ok: false,
                                error: "PYTHON_BAD_JSON",
                                message: e.message,
                                stdout: trimmed.slice(0, 4000),
                                stderr: stderr.slice(0, 2000) });
                        }
                    }
                    resolve({ ok: false, error: "PYTHON_NO_OUTPUT",
                        exitCode: code,
                        stderr: stderr.slice(0, 2000) });
                });
            } catch (e) {
                resolve({ ok: false, error: "PYTHON_SPAWN_THREW",
                    message: e.message || String(e) });
            }
        });
    }

    async function librosaDrumDetect(args) {
        var src = args && args.srcPath;
        if (!src) return { ok: false, error: "MISSING_SRC_PATH" };
        if (!fs.existsSync(src)) {
            return { ok: false, error: "SRC_NOT_FOUND", srcPath: src };
        }
        var pythonCmd = await findPython();
        if (!pythonCmd) {
            return { ok: false, error: "PYTHON_NOT_FOUND",
                message: "python / python3 not on PATH. Install Python "
                    + "3.8+ from https://www.python.org/downloads/ and "
                    + "ensure it resolves in a terminal, then reopen "
                    + "the PremBot Helper panel." };
        }
        var lookup = findPythonScript("drum_detect.py");
        if (!lookup.path) {
            return { ok: false, error: "SCRIPT_MISSING",
                candidates: lookup.candidates,
                message: "drum_detect.py not found in any of "
                    + lookup.candidates.length + " probed locations. "
                    + "Re-run install-windows.bat. Candidates checked: "
                    + lookup.candidates.map(function (c) {
                        return c.source + " -> " + c.tried;
                    }).join("  |  ") };
        }
        var scriptPath = lookup.path;
        log("script via " + lookup.source);
        var maxPerStream = (args && args.maxPerStream) || 256;
        var streams      = (args && args.streams)      || "all";
        log("librosa drums <- " + path.basename(src)
            + " (streams=" + streams + ")");
        return await new Promise(function (resolve) {
            var stdout = "", stderr = "";
            try {
                var p = spawnPython(
                    [scriptPath, src, String(maxPerStream),
                     String(streams)]);
                p.stdout.on("data", function (d) { stdout += String(d); });
                p.stderr.on("data", function (d) { stderr += String(d); });
                p.on("error", function (e) {
                    resolve({ ok: false, error: "PYTHON_SPAWN_ERROR",
                        message: e.message || String(e) });
                });
                p.on("close", function (code) {
                    var trimmed = stdout.trim();
                    if (trimmed) {
                        try {
                            var parsed = JSON.parse(trimmed);
                            return resolve(parsed);
                        } catch (e) {
                            return resolve({ ok: false,
                                error: "PYTHON_BAD_JSON",
                                message: e.message,
                                stdout: trimmed.slice(0, 4000),
                                stderr: stderr.slice(0, 2000) });
                        }
                    }
                    resolve({ ok: false, error: "PYTHON_NO_OUTPUT",
                        exitCode: code,
                        stderr: stderr.slice(0, 2000) });
                });
            } catch (e) {
                resolve({ ok: false, error: "PYTHON_SPAWN_THREW",
                    message: e.message || String(e) });
            }
        });
    }

    // Demucs stem separation. Splits a mixed audio file into 4 stems
    // (vocals / drums / bass / other) by spawning client/python/
    // stem_separate.py. Stems are cached at
    //   %TEMP%\PremBot-audio-cache\stems\<srcHash>-<mtime>\
    // keyed the same way extracted WAVs are, so a re-run on the same
    // source skips demucs entirely. Caller can specify which stems to
    // write, the torch device (auto/cuda/cpu), and the demucs model.
    async function demucsSeparate(args) {
        var src = args && args.srcPath;
        if (!src) return { ok: false, error: "MISSING_SRC_PATH" };
        if (!fs.existsSync(src)) {
            return { ok: false, error: "SRC_NOT_FOUND", srcPath: src };
        }
        var st;
        try { st = fs.statSync(src); }
        catch (e) {
            return { ok: false, error: "STAT_FAILED",
                message: e.message || String(e) };
        }
        var pythonCmd = await findPython();
        if (!pythonCmd) {
            return { ok: false, error: "PYTHON_NOT_FOUND",
                message: "python / python3 not on PATH. Install Python "
                    + "3.8+ from https://www.python.org/downloads/ and "
                    + "ensure it resolves in a terminal, then reopen "
                    + "the PremBot Helper panel." };
        }
        var lookup = findPythonScript("stem_separate.py");
        if (!lookup.path) {
            return { ok: false, error: "SCRIPT_MISSING",
                candidates: lookup.candidates,
                message: "stem_separate.py not found in any of "
                    + lookup.candidates.length + " probed locations. "
                    + "Re-run install-windows.bat. Candidates checked: "
                    + lookup.candidates.map(function (c) {
                        return c.source + " -> " + c.tried;
                    }).join("  |  ") };
        }
        var scriptPath = lookup.path;

        // Per-source cache directory: hash + mtime invalidates if the
        // user re-encodes / replaces the file.
        var stemsRoot = path.join(audioCacheDir(), "stems");
        if (!fs.existsSync(stemsRoot)) {
            fs.mkdirSync(stemsRoot, { recursive: true });
        }
        var key = hashPath(src) + "-" + Math.floor(st.mtimeMs);
        var outDir = path.join(stemsRoot, key);

        // Strip the extension - the python sidecar appends .<stem>.wav.
        var basename = path.basename(src, path.extname(src));

        var stems  = (args && args.stems)  || "all";
        var device = (args && args.device) || "auto";
        var model  = (args && args.model)  || "htdemucs";

        log("demucs <- " + path.basename(src) + " (device="
            + device + ", stems=" + stems + ")");
        return await new Promise(function (resolve) {
            var stdout = "", stderr = "";
            try {
                var p = spawnPython(
                    [scriptPath, src, outDir, basename,
                     String(stems), String(device), String(model)]);
                p.stdout.on("data", function (d) { stdout += String(d); });
                p.stderr.on("data", function (d) { stderr += String(d); });
                p.on("error", function (e) {
                    resolve({ ok: false, error: "PYTHON_SPAWN_ERROR",
                        message: e.message || String(e) });
                });
                p.on("close", function (code) {
                    var trimmed = stdout.trim();
                    if (trimmed) {
                        try {
                            var parsed = JSON.parse(trimmed);
                            if (parsed && parsed.ok) parsed.outDir = outDir;
                            // Self-diagnosing: which interpreter did
                            // we just try? Lets the user see e.g.
                            //   pythonExe: "C:\Python311\python.exe"
                            // alongside DEMUCS_NOT_INSTALLED.
                            if (parsed) parsed.pythonExe = resolvedPythonExe();
                            return resolve(parsed);
                        } catch (e) {
                            return resolve({ ok: false,
                                error: "PYTHON_BAD_JSON",
                                message: e.message,
                                pythonExe: resolvedPythonExe(),
                                stdout: trimmed.slice(0, 4000),
                                stderr: stderr.slice(0, 2000) });
                        }
                    }
                    resolve({ ok: false, error: "PYTHON_NO_OUTPUT",
                        exitCode: code,
                        pythonExe: resolvedPythonExe(),
                        stderr: stderr.slice(0, 2000) });
                });
            } catch (e) {
                resolve({ ok: false, error: "PYTHON_SPAWN_THREW",
                    message: e.message || String(e) });
            }
        });
    }

    // Vision-cache root. Mirrors audioCacheDir() but for clip analysis
    // (sampled frames + analysis.json) so the visual feature stream
    // is bucketed separately from the audio pipeline's cache.
    function visionCacheDir() {
        var d = path.join(os.tmpdir(), "PremBot-vision-cache");
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        return d;
    }

    // analyze_clip: spawn client/python/vision_analyze.py to extract N
    // frames via ffmpeg, compute numeric motion / dominantColors, run
    // Qwen2.5-VL-7B for structured semantic fields (mood, energy,
    // sceneType, hasPeople, bestFrame), and pool an OpenCLIP ViT-H/14
    // embedding for downstream clustering. Two-layer cache: bridge.js
    // builds a per-clip dir keyed by srcHash + mtime + frameCount + a
    // hash of the model env vars (so swapping models invalidates the
    // cache without manual purges). The sidecar fast-paths on a present
    // analysis.json so warm calls return without importing torch.
    //
    // Env-var contract (read on every call so users can swap models
    // without restarting Premiere):
    //   PREMBOT_MODEL_DIR              base dir under which model
    //                                  filenames resolve (probes
    //                                  ComfyUI's subdir layout).
    //   PREMBOT_VISION_MODEL           primary VLM. Default
    //                                  Qwen/Qwen2.5-VL-7B-Instruct.
    //                                  May be HF repo id, abs path
    //                                  folder, or filename under
    //                                  PREMBOT_MODEL_DIR.
    //   PREMBOT_VISION_MODEL_FALLBACK  fallback VLM tried on refusal/
    //                                  unparseable output.
    //   PREMBOT_CLIP_VISION_MODEL      OpenCLIP ViT-H/14 weights file
    //                                  (e.g. clip_vision_h.safetensors
    //                                  under ComfyUI's clip_vision/).
    //                                  Empty -> auto-download.
    // VisionDaemon manages a long-lived Python process running
    // client/python/vision_daemon.py. Spawned lazily on the first
    // analyze_clip call and kept alive until the panel closes, so
    // the ~30-60s model load tax is paid ONCE instead of per call.
    //
    // Protocol: JSON-Lines RPC over stdin/stdout. One JSON object per
    // line, request/response keyed by an integer id. The daemon also
    // emits asynchronous notifications (events) with no id - those
    // get logged but don't resolve any pending request.
    //
    // Fault tolerance: if the daemon process dies, any pending requests
    // reject, the daemon is marked dead, and the NEXT analyze_clip
    // call will respawn it. If spawn itself fails (e.g., missing
    // script, broken Python), visionAnalyzeClip falls back to one-shot
    // mode automatically.
    function VisionDaemon(scriptPath, pythonCmd) {
        this.scriptPath = scriptPath;
        this.pythonCmd = pythonCmd;
        this.process = null;
        this.pending = new Map();    // id -> {resolve, reject, method}
        this.stdoutBuffer = "";
        this.stderrBuffer = "";
        this.startPromise = null;
        this.ready = false;
        this.events = [];            // last 20 events for diagnostics
        this.startErrors = [];
        this.seq = 0;
    }

    VisionDaemon.prototype._nextId = function () {
        this.seq = (this.seq + 1) >>> 0;
        return "vd-" + process.pid + "-" + this.seq;
    };

    VisionDaemon.prototype._recordEvent = function (msg) {
        this.events.push({ ts: Date.now(),
            event: msg.event, data: msg.data });
        if (this.events.length > 20) this.events.shift();
        log("vision daemon event: " + msg.event
            + (msg.data ? " " + JSON.stringify(msg.data).slice(0, 200)
                        : ""));
    };

    VisionDaemon.prototype._onStdout = function (chunk) {
        this.stdoutBuffer += String(chunk);
        var nl;
        while ((nl = this.stdoutBuffer.indexOf("\n")) !== -1) {
            var line = this.stdoutBuffer.slice(0, nl).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
            if (!line) continue;
            var msg;
            try { msg = JSON.parse(line); }
            catch (e) {
                log("vision daemon non-JSON line: " + line.slice(0, 200));
                continue;
            }
            if (msg.event) {
                this._recordEvent(msg);
                if (msg.event === "ready" && this.startResolve) {
                    this.ready = true;
                    this.startResolve();
                    this.startResolve = null;
                    this.startReject = null;
                }
                continue;
            }
            // Response. Match by id.
            var entry = this.pending.get(msg.id);
            if (!entry) {
                log("vision daemon: orphan response id=" + msg.id);
                continue;
            }
            this.pending.delete(msg.id);
            if (msg.error) entry.reject(msg.error);
            else entry.resolve(msg.result);
        }
    };

    VisionDaemon.prototype._onStderr = function (chunk) {
        // Capture for crash diagnostics. The daemon prints all
        // torch / transformers / open_clip output to stderr so this
        // can get noisy; we keep a rolling tail for emergencies.
        this.stderrBuffer += String(chunk);
        if (this.stderrBuffer.length > 8192) {
            this.stderrBuffer = this.stderrBuffer.slice(-8192);
        }
    };

    VisionDaemon.prototype._onExit = function (code, signal) {
        log("vision daemon exited code=" + code + " signal=" + signal);
        this.ready = false;
        var dead = this.process;
        this.process = null;
        // Reject every pending request - they will not be answered.
        var stderrTail = this.stderrBuffer.slice(-2000);
        this.pending.forEach(function (entry) {
            entry.reject({
                code: "DAEMON_EXITED",
                exitCode: code, signal: signal,
                method: entry.method,
                stderr: stderrTail });
        });
        this.pending.clear();
        if (this.startReject) {
            this.startReject({
                code: "DAEMON_EXITED_DURING_START",
                exitCode: code, signal: signal,
                stderr: stderrTail });
            this.startResolve = null;
            this.startReject = null;
        }
    };

    VisionDaemon.prototype.ensureRunning = function () {
        var self = this;
        if (self.process && self.ready) {
            return Promise.resolve();
        }
        if (self.startPromise) return self.startPromise;

        self.startPromise = new Promise(function (resolve, reject) {
            self.startResolve = resolve;
            self.startReject = reject;
            self.stdoutBuffer = "";
            self.stderrBuffer = "";
            self.startErrors = [];
            try {
                self.process = spawnPython([self.scriptPath]);
            } catch (e) {
                reject({ code: "SPAWN_THREW",
                    message: e && (e.message || String(e)) });
                self.startResolve = null;
                self.startReject = null;
                return;
            }
            self.process.stdout.on("data",
                function (d) { self._onStdout(d); });
            self.process.stderr.on("data",
                function (d) { self._onStderr(d); });
            self.process.on("error", function (e) {
                self.startErrors.push(e.message || String(e));
            });
            self.process.on("exit", function (code, signal) {
                self._onExit(code, signal);
            });
            // Failsafe: if no "ready" event arrives in 15s, the daemon
            // is probably stuck importing something. Bail so the
            // caller can fall back to one-shot.
            var readyTimeout = setTimeout(function () {
                if (!self.ready && self.startReject) {
                    self.startReject({
                        code: "READY_TIMEOUT",
                        message: "Daemon did not emit 'ready' in 15s",
                        stderr: self.stderrBuffer.slice(-2000) });
                    self.startResolve = null;
                    self.startReject = null;
                    try { self.process.kill(); } catch (eK) {}
                }
            }, 15000);
            // Clear the timeout once start resolves either way.
            var origResolve = self.startResolve;
            var origReject  = self.startReject;
            self.startResolve = function () {
                clearTimeout(readyTimeout);
                if (origResolve) origResolve();
            };
            self.startReject = function (e) {
                clearTimeout(readyTimeout);
                if (origReject) origReject(e);
            };
        });
        self.startPromise.catch(function () { /* swallow */ })
            .then(function () { self.startPromise = null; });
        return self.startPromise;
    };

    VisionDaemon.prototype.request = function (method, params) {
        var self = this;
        return self.ensureRunning().then(function () {
            return new Promise(function (resolve, reject) {
                var id = self._nextId();
                self.pending.set(id, { resolve: resolve,
                    reject: reject, method: method });
                try {
                    self.process.stdin.write(
                        JSON.stringify({ id: id, method: method,
                                         params: params || {} })
                        + "\n");
                } catch (e) {
                    self.pending.delete(id);
                    reject({ code: "STDIN_WRITE_FAILED",
                        message: e && (e.message || String(e)) });
                }
            });
        });
    };

    VisionDaemon.prototype.shutdown = function () {
        if (!this.process) return;
        try {
            this.process.stdin.write(
                JSON.stringify({ method: "shutdown" }) + "\n");
        } catch (e) {}
        var proc = this.process;
        // Hard-kill if it doesn't exit in 3s.
        setTimeout(function () {
            try { if (proc && !proc.killed) proc.kill(); } catch (e) {}
        }, 3000);
    };

    // Module-level singleton: one daemon per helper panel instance.
    var _visionDaemon = null;
    function getVisionDaemon() {
        if (_visionDaemon) return _visionDaemon;
        var lookup = findPythonScript("vision_daemon.py");
        if (!lookup.path) return null;
        _visionDaemon = new VisionDaemon(lookup.path, cachedPython);
        return _visionDaemon;
    }

    async function visionAnalyzeClip(args) {
        var src = args && args.srcPath;
        if (!src) return { ok: false, error: "MISSING_SRC_PATH" };
        if (!fs.existsSync(src)) {
            return { ok: false, error: "SRC_NOT_FOUND", srcPath: src };
        }
        var st;
        try { st = fs.statSync(src); }
        catch (e) {
            return { ok: false, error: "STAT_FAILED",
                message: e.message || String(e) };
        }
        var pythonCmd = await findPython();
        if (!pythonCmd) {
            return { ok: false, error: "PYTHON_NOT_FOUND",
                message: "python / python3 not on PATH. Install Python "
                    + "3.10+ from https://www.python.org/downloads/ or "
                    + "set PREMBOT_PYTHON to an absolute python.exe "
                    + "path, then reopen the PremBot Helper panel." };
        }
        var lookup = findPythonScript("vision_analyze.py");
        if (!lookup.path) {
            return { ok: false, error: "SCRIPT_MISSING",
                candidates: lookup.candidates,
                message: "vision_analyze.py not found in any of "
                    + lookup.candidates.length + " probed locations. "
                    + "Re-run install-windows.bat. Candidates checked: "
                    + lookup.candidates.map(function (c) {
                        return c.source + " -> " + c.tried;
                    }).join("  |  ") };
        }
        var scriptPath = lookup.path;

        var modelDir       = process.env.PREMBOT_MODEL_DIR || "";
        var visionModel    = process.env.PREMBOT_VISION_MODEL
            || "Qwen/Qwen2.5-VL-7B-Instruct";
        var visionFallback = process.env.PREMBOT_VISION_MODEL_FALLBACK
            || "";
        var clipVisionModel = process.env.PREMBOT_CLIP_VISION_MODEL
            || "";

        var frameCount = (args && args.frameCount) || 6;
        var device     = (args && args.device)     || "auto";
        var maxDim     = (args && args.maxDim)     || 512;

        // Cache key folds in the model env-var set so swapping any
        // model invalidates without manual purges. We hash the joined
        // env values rather than embedding them (model paths are too
        // long to be filenames on Windows).
        var modelEnvHash = crypto.createHash("sha1").update(
            [modelDir, visionModel, visionFallback,
             clipVisionModel].join("|")
        ).digest("hex").slice(0, 8);
        var key = hashPath(src) + "-" + Math.floor(st.mtimeMs)
            + "-N" + frameCount + "-" + modelEnvHash;
        var outDir = path.join(visionCacheDir(), key);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        var basename = path.basename(src, path.extname(src));

        // Daemon-first path: shared Python process, models stay loaded
        // across analyze calls. Falls back to one-shot vision_analyze.py
        // if the daemon fails to start (missing script, broken Python,
        // user opted out via PREMBOT_VISION_USE_DAEMON=0).
        var useDaemon = process.env.PREMBOT_VISION_USE_DAEMON !== "0";
        var daemon = useDaemon ? getVisionDaemon() : null;
        if (daemon) {
            log("vision (daemon) <- " + path.basename(src)
                + " (frames=" + frameCount + ", device=" + device + ")");
            try {
                var result = await daemon.request("analyze", {
                    srcPath: src,
                    outDir: outDir,
                    basename: basename,
                    frameCount: frameCount,
                    device: device,
                    maxDim: maxDim
                });
                if (result) {
                    result.outDir = outDir;
                    result.pythonExe = resolvedPythonExe();
                    result.executionMode = "daemon";
                }
                return result;
            } catch (e) {
                // Daemon RPC failure. Log it and fall through to the
                // one-shot path so the user still gets a result.
                log("vision daemon RPC failed: "
                    + JSON.stringify(e).slice(0, 300));
            }
        }

        log("vision (one-shot) <- " + path.basename(src) + " (frames="
            + frameCount + ", device=" + device + ")");
        return await new Promise(function (resolve) {
            var stdout = "", stderr = "";
            try {
                var p = spawnPython(
                    [scriptPath, src, outDir, basename,
                     String(frameCount), modelDir, visionModel,
                     visionFallback, clipVisionModel, String(device),
                     String(maxDim)]);
                p.stdout.on("data", function (d) { stdout += String(d); });
                p.stderr.on("data", function (d) { stderr += String(d); });
                p.on("error", function (e) {
                    resolve({ ok: false, error: "PYTHON_SPAWN_ERROR",
                        message: e.message || String(e) });
                });
                p.on("close", function (code) {
                    var trimmed = stdout.trim();
                    if (trimmed) {
                        try {
                            var parsed = JSON.parse(trimmed);
                            if (parsed) {
                                parsed.outDir = outDir;
                                parsed.pythonExe = resolvedPythonExe();
                                parsed.executionMode = "one_shot";
                            }
                            return resolve(parsed);
                        } catch (e) {
                            return resolve({ ok: false,
                                error: "PYTHON_BAD_JSON",
                                message: e.message,
                                pythonExe: resolvedPythonExe(),
                                stdout: trimmed.slice(0, 4000),
                                stderr: stderr.slice(0, 2000) });
                        }
                    }
                    resolve({ ok: false, error: "PYTHON_NO_OUTPUT",
                        exitCode: code,
                        pythonExe: resolvedPythonExe(),
                        stderr: stderr.slice(0, 2000) });
                });
            } catch (e) {
                resolve({ ok: false, error: "PYTHON_SPAWN_THREW",
                    message: e.message || String(e) });
            }
        });
    }

    var server = http.createServer(async function (req, res) {
        if (req.method === "OPTIONS") return send(res, 204, {});
        try {
            var u = req.url || "";
            if (u === "/ping") {
                return send(res, 200, { ok: true, helper: "PremBot",
                    version: "0.3.0" });
            }
            // POST /exec/:tool with JSON body of args
            var m = u.match(/^\/exec\/([a-z_][a-z0-9_]*)$/i);
            if (req.method === "POST" && m) {
                var tool = m[1];
                var args = await readBody(req);
                log("exec " + tool + " " + JSON.stringify(args));
                // Node-side handlers short-circuit before the
                // ExtendScript dispatch.
                if (NODE_HANDLERS[tool]) {
                    var nodeResult = await NODE_HANDLERS[tool](args);
                    if (nodeResult && nodeResult.ok !== false) nodeResult.ok = true;
                    nodeResult.tool = tool;
                    log("  -> " + JSON.stringify(nodeResult).slice(0, 200));
                    return send(res, 200, nodeResult);
                }
                var result = await evalAsync(jsxCall(tool, args));
                log("  -> " + JSON.stringify(result).slice(0, 200));
                return send(res, 200, result);
            }
            send(res, 404, { ok: false, error: "Not Found" });
        } catch (e) {
            send(res, 500, { ok: false, error: e && (e.message || String(e)) });
        }
    });

    // Fixed port so the UXP panel can whitelist it in its manifest.
    // network.domains. UXP doesn't allow port wildcards.
    var HELPER_PORT = 53210;
    server.on("error", function (err) {
        $("status").textContent = "port " + HELPER_PORT + " busy: "
            + (err.code || err.message || err);
        log("Could not bind " + HELPER_PORT + ": "
            + (err.code || err.message || err));
    });
    server.listen(HELPER_PORT, "127.0.0.1", function () {
        var addr = server.address();
        var port = addr.port;
        $("port").textContent = String(port);
        $("status").textContent = "running";
        $("status").className = "status running";
        try {
            var statusPath = writeStatus({
                ok: true,
                port: port,
                pid: process.pid,
                version: "0.3.0",
                startedAt: new Date().toISOString()
            });
            log("Bridge listening on 127.0.0.1:" + port);
            log("Wrote status: " + statusPath);
            // Settles the MCP-SDK-vs-hand-rolled decision in
            // docs/PHASE1-SPEC.md STEP 1. CEP 12 is the last major CEP
            // update and likely pins Node around 17.x; the official MCP
            // TypeScript SDK needs 18+. Read this line, don't speculate.
            log("node " + process.version);
        } catch (e) {
            log("Could not write status file: " + (e.message || e));
        }
    });

    // Cleanup on panel close.
    window.addEventListener("beforeunload", function () {
        try { if (_visionDaemon) _visionDaemon.shutdown(); } catch (e) {}
        try { server.close(); } catch (e) {}
        try {
            var statusPath = path.join(appDataDir(), "helper-status.json");
            if (fs.existsSync(statusPath)) fs.unlinkSync(statusPath);
        } catch (e) {}
    });
})();
