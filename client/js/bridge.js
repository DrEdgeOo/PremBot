// PremBot CEP Helper - localhost HTTP bridge.
//
// Lives inside a CEP panel so it can both (a) call ExtendScript via
// CSInterface and (b) run a Node HTTP server (CEP's runtime ships Node).
// The UXP panel posts to http://localhost:<port>/exec/:tool with JSON
// args; we evalScript a matching JSX function and return the result.
//
// Port is dynamic (random free port from the OS). We write it to a
// status file the UXP panel watches:
//   %APPDATA%\PremBot\helper-status.json (Windows)
//   ~/Library/Application Support/PremBot/helper-status.json (macOS)
// so the UXP side can discover the bridge without hardcoded ports.

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
    var NODE_HANDLERS = {
        extract_wav: extractWav,
        librosa_beat_track: librosaBeatTrack
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
                            exitCode: code, stderr: stderr.slice(0, 1000) });
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
    function beatTrackScriptPath() {
        // CEP's getSystemPath takes a string key. "extension" returns
        // the install dir of THIS extension. The minimal CSInterface
        // shim doesn't expose the SystemPath constant object, so use
        // the literal string the underlying __adobe_cep__ API accepts.
        try {
            var ext = csi.getSystemPath ? csi.getSystemPath("extension") : "";
            if (ext) return path.join(ext, "client", "python", "beat_track.py");
        } catch (e) {}
        return null;
    }

    // Try "python" first (Windows installer's default name), then
    // "python3" (typical on Unix/macOS). Returns the working command
    // string or null. Cached after first successful probe so each
    // detect_beats call doesn't re-probe.
    var cachedPython = null;
    function findPython() {
        if (cachedPython) return Promise.resolve(cachedPython);
        return new Promise(function (resolve) {
            function tryCmd(cmd, next) {
                try {
                    var p = spawn(cmd, ["--version"], { windowsHide: true });
                    var done = false;
                    p.on("error", function () {
                        if (done) return; done = true; next();
                    });
                    p.on("close", function (code) {
                        if (done) return; done = true;
                        if (code === 0) { cachedPython = cmd; resolve(cmd); }
                        else next();
                    });
                } catch (e) { next(); }
            }
            tryCmd("python", function () {
                tryCmd("python3", function () { resolve(null); });
            });
        });
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
        var scriptPath = beatTrackScriptPath();
        if (!scriptPath || !fs.existsSync(scriptPath)) {
            return { ok: false, error: "SCRIPT_MISSING",
                scriptPath: scriptPath || "(extension path unavailable)",
                message: "beat_track.py not found at expected location. "
                    + "Re-run install-windows.bat to refresh the CEP "
                    + "extension dir." };
        }
        var maxBeats = (args && args.maxBeats) || 256;
        log("librosa <- " + path.basename(src));
        return await new Promise(function (resolve) {
            var stdout = "", stderr = "";
            try {
                var p = spawn(pythonCmd,
                    [scriptPath, src, String(maxBeats)],
                    { windowsHide: true });
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
                                stdout: trimmed.slice(0, 1000),
                                stderr: stderr.slice(0, 1000) });
                        }
                    }
                    resolve({ ok: false, error: "PYTHON_NO_OUTPUT",
                        exitCode: code,
                        stderr: stderr.slice(0, 1000) });
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
        } catch (e) {
            log("Could not write status file: " + (e.message || e));
        }
    });

    // Cleanup on panel close.
    window.addEventListener("beforeunload", function () {
        try { server.close(); } catch (e) {}
        try {
            var statusPath = path.join(appDataDir(), "helper-status.json");
            if (fs.existsSync(statusPath)) fs.unlinkSync(statusPath);
        } catch (e) {}
    });
})();
