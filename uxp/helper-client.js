// CEP helper bridge client - lives in the UXP panel, discovers the
// localhost HTTP port the CEP companion published via a status file,
// then POSTs tool calls over to it.
//
// UXP cannot call ExtendScript directly (no evalScript in UXP). The
// CEP companion panel runs alongside us inside Premiere and exposes
// ExtendScript-only operations (trim, split, insert from bin, marker)
// as HTTP endpoints. Adobe confirmed in April 2025 there is no
// evalScript from UXP, so this two-panel architecture is canonical.
//
// Status file layout, written by client/js/bridge.js in the CEP panel:
//   {
//     ok: true,
//     port: <number>,
//     pid: <number>,
//     version: "0.3.0",
//     startedAt: ISO8601
//   }
// at %APPDATA%\PremBot\helper-status.json on Windows or
//    ~/Library/Application Support/PremBot/helper-status.json on macOS.

(function () {
    const uxp = require("uxp");
    const os  = require("os");

    // Helper listens on a fixed port (53210) because UXP's network
    // permissions can't whitelist a dynamic port. We still consult the
    // status file as a "is the helper actually running?" liveness
    // signal before each call, but the port itself is hard-coded.
    const HELPER_PORT = 53210;
    let cachedPort = null;
    let cachedAt   = 0;
    const CACHE_TTL_MS = 5000;

    async function findStatusFolder() {
        const fs = uxp.storage.localFileSystem;
        // Try platform-specific known paths via file:// URL.
        const home = os.homedir().replace(/\\/g, "/");
        const win  = "file:///" + (process.env.APPDATA || (home + "/AppData/Roaming"))
            .replace(/\\/g, "/").replace(/^\//, "") + "/PremBot/";
        const mac  = "file://" + home + "/Library/Application Support/PremBot/";
        const candidates = [win, mac];
        for (const url of candidates) {
            try {
                const entry = await fs.getEntryWithUrl(url);
                if (entry && entry.isFolder) return entry;
            } catch (e) {}
        }
        return null;
    }

    async function readStatus() {
        const folder = await findStatusFolder();
        if (!folder) return null;
        try {
            const file = await folder.getEntry("helper-status.json");
            const text = await file.read();
            return JSON.parse(text);
        } catch (e) { return null; }
    }

    async function getPort(forceRefresh) {
        const now = Date.now();
        if (!forceRefresh && cachedPort && now - cachedAt < CACHE_TTL_MS) {
            return cachedPort;
        }
        // If the status file reports a different port (e.g. user
        // edited bridge.js to use a different one), trust it; manifest
        // would need to be updated to match. In the canonical setup
        // the port is HELPER_PORT.
        const status = await readStatus();
        const port = (status && status.port) || HELPER_PORT;
        cachedPort = port;
        cachedAt = now;
        return port;
    }

    async function isAvailable() {
        const port = await getPort();
        if (!port) return { ok: false, reason: "no_status_file",
            hint: "Open the PremBot Helper panel in Premiere "
                + "(Window > Extensions > PremBot Helper). It writes "
                + "%APPDATA%\\PremBot\\helper-status.json when running." };
        try {
            const r = await fetch("http://127.0.0.1:" + port + "/ping",
                { method: "GET" });
            if (!r.ok) return { ok: false, port, reason: "ping_status_"
                + r.status };
            const body = await r.json();
            return { ok: true, port, helper: body };
        } catch (e) {
            // Stale port. Drop the cache and report.
            cachedPort = null;
            return { ok: false, port,
                reason: "ping_failed: " + (e && (e.message || String(e))) };
        }
    }

    async function call(toolName, args) {
        const port = await getPort();
        if (!port) {
            return { ok: false, error: "HELPER_NOT_RUNNING",
                message: "PremBot Helper isn't running. Open it via "
                    + "Window > Extensions > PremBot Helper, then retry." };
        }
        const url = "http://127.0.0.1:" + port + "/exec/" + toolName;
        let res;
        try {
            res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(args || {})
            });
        } catch (e) {
            cachedPort = null;
            return { ok: false, error: "HELPER_UNREACHABLE",
                message: e && (e.message || String(e)) };
        }
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            return { ok: false, error: "HELPER_HTTP_" + res.status,
                message: text };
        }
        try { return await res.json(); }
        catch (e) {
            return { ok: false, error: "HELPER_BAD_JSON",
                message: e && (e.message || String(e)) };
        }
    }

    globalThis.PremBotHelper = { call, isAvailable, getPort };
})();
