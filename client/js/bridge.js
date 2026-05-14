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
    var http = require("http");
    var fs   = require("fs");
    var os   = require("os");
    var path = require("path");

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
                var result = await evalAsync(jsxCall(tool, args));
                log("  -> " + JSON.stringify(result).slice(0, 200));
                return send(res, 200, result);
            }
            send(res, 404, { ok: false, error: "Not Found" });
        } catch (e) {
            send(res, 500, { ok: false, error: e && (e.message || String(e)) });
        }
    });

    // Listen on a random free port (0).
    server.listen(0, "127.0.0.1", function () {
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
