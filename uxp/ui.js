// PremBot panel UI: settings persistence, agent run controls, log rendering.

(function () {
    const SETTINGS_KEY = "prembot.settings.v1";

    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (!raw) return {};
            return JSON.parse(raw);
        } catch (e) { return {}; }
    }
    function saveSettings(s) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
        catch (e) {}
    }

    function $(id) { return document.getElementById(id); }

    function appendLog(entry) {
        const log = $("log");
        const ts = new Date().toLocaleTimeString();
        let line;
        switch (entry.kind) {
            case "call":
                line = "[" + ts + "] turn " + entry.turn + " → calling Claude";
                break;
            case "assistant":
                line = "[" + ts + "] assistant: " + entry.text;
                break;
            case "tool_call":
                line = "[" + ts + "] tool " + entry.name + "("
                    + JSON.stringify(entry.input) + ")";
                break;
            case "tool_result":
                line = "[" + ts + "]   → "
                    + JSON.stringify(entry.result);
                break;
            case "tool_error":
                line = "[" + ts + "]   ✗ " + entry.name + ": " + entry.error;
                break;
            case "finish":
                line = "[" + ts + "] finish: " + entry.summary;
                break;
            case "stop":
                line = "[" + ts + "] done (" + entry.reason + ")";
                break;
            case "abort":
                line = "[" + ts + "] aborted at turn " + entry.turn;
                break;
            case "max_turns":
                line = "[" + ts + "] max turns reached";
                break;
            default:
                line = "[" + ts + "] " + JSON.stringify(entry);
        }
        log.textContent += (log.textContent ? "\n" : "") + line;
        log.scrollTop = log.scrollHeight;
    }

    // ---- Settings panel ----

    function initSettings() {
        const settings = loadSettings();
        $("cfg-key").value = settings.apiKey || "";
        if (settings.model) $("cfg-model").value = settings.model;

        $("btn-settings").addEventListener("click", () => {
            $("settings").classList.toggle("hidden");
        });
        $("btn-save-settings").addEventListener("click", () => {
            const s = {
                apiKey: $("cfg-key").value.trim(),
                model:  $("cfg-model").value
            };
            saveSettings(s);
            $("settings-status").textContent = "Saved";
            setTimeout(() => { $("settings-status").textContent = ""; }, 2000);
        });
    }

    // ---- Run / Cancel ----

    let abortController = null;

    function initAgentControls() {
        $("btn-run").addEventListener("click", async () => {
            const settings = loadSettings();
            if (!settings.apiKey) {
                $("run-status").textContent = "Set API key in Settings first.";
                return;
            }
            const prompt = $("ai-prompt").value.trim();
            if (!prompt) {
                $("run-status").textContent = "Type a prompt first.";
                return;
            }
            $("log").textContent = "";
            $("run-status").textContent = "Running...";
            $("btn-run").disabled = true;
            $("btn-cancel").disabled = false;
            abortController = { aborted: false };
            try {
                const result = await globalThis.PremBotAgent.runAgent({
                    apiKey:     settings.apiKey,
                    model:      settings.model || "claude-sonnet-4-6",
                    userPrompt: prompt,
                    log:        appendLog,
                    signal:     abortController
                });
                $("run-status").textContent = result.aborted
                    ? "Aborted."
                    : (result.ok ? "Done." : "Stopped: " + (result.error || ""));
            } catch (e) {
                appendLog({ kind: "tool_error", turn: 0, name: "agent",
                    error: e && (e.stack || e.message || String(e)) });
                $("run-status").textContent = "Error.";
            } finally {
                $("btn-run").disabled = false;
                $("btn-cancel").disabled = true;
                abortController = null;
            }
        });

        $("btn-cancel").addEventListener("click", () => {
            if (abortController) {
                abortController.aborted = true;
                $("run-status").textContent = "Aborting...";
            }
        });
    }

    function init() {
        initSettings();
        initAgentControls();
        initCopyAll();
        initCopyLog();
    }

    function initCopyLog() {
        const btn = document.getElementById("btn-copy-log");
        const status = document.getElementById("run-status");
        if (!btn) return;
        btn.addEventListener("click", async () => {
            const text = (document.getElementById("log").textContent || "")
                .trim() || "(log is empty)";
            try {
                await navigator.clipboard.writeText(text);
                status.textContent = "Copied " + text.length + " chars";
            } catch (e) {
                status.textContent = "Copy failed: " + (e && (e.message || e));
            }
            setTimeout(() => { status.textContent = ""; }, 3000);
        });
    }

    function initCopyAll() {
        const btn = document.getElementById("btn-copy");
        if (!btn) return;
        // Replace the diagnostic-only copy handler from index.js by
        // re-binding the same button to copy BOTH panes.
        const cloned = btn.cloneNode(true);
        btn.parentNode.replaceChild(cloned, btn);
        const status = document.getElementById("copy-status");
        cloned.addEventListener("click", async () => {
            const diag = (document.getElementById("output").textContent || "").trim();
            const log  = (document.getElementById("log").textContent || "").trim();
            const parts = [];
            if (log)  parts.push("=== AI Edit log ===\n" + log);
            if (diag) parts.push("=== Diagnostics ===\n" + diag);
            const text = parts.join("\n\n") || "(nothing to copy)";
            try {
                await navigator.clipboard.writeText(text);
                status.textContent = "Copied " + text.length + " chars";
            } catch (e) {
                status.textContent = "Copy failed: " + (e && (e.message || e));
            }
            setTimeout(() => { status.textContent = ""; }, 3000);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
