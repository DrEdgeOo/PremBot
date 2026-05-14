// Entry point — wires the UI to storage, host bridge, transcription, and agent.
(function () {
    var settings    = Storage.getSettings();
    var transcripts = Storage.getTranscripts();
    var lastPlan    = [];

    // --- Tab nav ---
    UI.$$('.tabs button').forEach(function (b) {
        b.addEventListener('click', function () { UI.switchTab(b.dataset.tab); });
    });

    // --- Settings tab ---
    function hydrateSettings() {
        UI.$('#key-anthropic').value = settings.anthropicKey || '';
        UI.$('#key-openai').value    = settings.openaiKey    || '';
        UI.$('#model').value         = settings.model        || 'claude-sonnet-4-6';
        UI.$('#style-profile').value = settings.styleProfile || '';
    }
    hydrateSettings();

    UI.$('#save-settings').addEventListener('click', function () {
        settings.anthropicKey = UI.$('#key-anthropic').value.trim();
        settings.openaiKey    = UI.$('#key-openai').value.trim();
        settings.model        = UI.$('#model').value;
        settings.styleProfile = UI.$('#style-profile').value;
        Storage.saveSettings(settings);
        UI.$('#settings-status').textContent = 'Saved ' + new Date().toLocaleTimeString();
        UI.toast('Settings saved');
    });

    // --- Footage tab ---
    var currentClips = [];

    async function refreshClips() {
        try {
            currentClips = await Host.listProjectClips();
            UI.renderClips(currentClips, transcripts);
        } catch (e) {
            UI.toast('Failed to list clips: ' + e.message);
        }
    }
    UI.$('#refresh-clips').addEventListener('click', refreshClips);

    UI.$('#transcribe-all').addEventListener('click', async function () {
        if (!settings.openaiKey) { UI.toast('Set your OpenAI key in Settings first.'); return; }
        if (!currentClips.length) { await refreshClips(); }
        var pending = currentClips.filter(function (c) { return !transcripts[c.path]; });
        if (!pending.length) { UI.toast('All clips already transcribed.'); return; }

        UI.$('#transcribe-all').disabled = true;
        for (var i = 0; i < pending.length; i++) {
            var clip = pending[i];
            UI.renderClips(currentClips, transcripts, clip.path);
            try {
                var tr = await Transcribe.file(clip.path, settings.openaiKey);
                transcripts[clip.path] = tr;
                Storage.saveTranscripts(transcripts);
            } catch (e) {
                UI.toast('Transcribe failed: ' + clip.name + ' — ' + e.message);
            }
            UI.renderClips(currentClips, transcripts);
        }
        UI.$('#transcribe-all').disabled = false;
        UI.toast('Transcription complete');
    });

    // --- Chat / agent ---
    UI.$('#composer').addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var prompt = UI.$('#prompt').value.trim();
        if (!prompt) return;
        if (!settings.anthropicKey) { UI.toast('Set your Anthropic key in Settings first.'); return; }

        UI.addMessage('user', prompt);
        UI.$('#prompt').value = '';
        UI.clearPlan();
        lastPlan = [];

        var seqInfo = null;
        try { seqInfo = await Host.getActiveSequenceInfo(); } catch (e) {}

        var mode = UI.getMode();
        UI.$('#send').disabled = true;

        try {
            var ctx = await Agent.run({
                userPrompt:  prompt,
                settings:    settings,
                mode:        mode,
                transcripts: transcripts,
                seqInfo:     seqInfo,
                onEvent:     function (ev) {
                    if (ev.type === 'assistant_text') {
                        UI.addMessage('assistant', ev.text);
                    } else if (ev.type === 'tool_use') {
                        UI.addMessage('tool', '→ ' + ev.name + '(' + _short(ev.input) + ')');
                    } else if (ev.type === 'tool_result') {
                        UI.addMessage('tool', '  ' + (ev.isError ? '✗ ' : '✓ ') + ev.name + ' → ' + _short(ev.result));
                    } else if (ev.type === 'error') {
                        UI.addMessage('error', ev.error);
                    }
                }
            });
            lastPlan = ctx.plan || [];
            if (mode === 'plan' && lastPlan.length) {
                UI.renderPlan(lastPlan);
            } else if (mode === 'auto' && lastPlan.length === 0) {
                UI.toast('Edit applied to timeline');
            }
            if (ctx.summary) UI.addMessage('assistant', ctx.summary);
        } catch (e) {
            UI.addMessage('error', e.message);
        } finally {
            UI.$('#send').disabled = false;
        }
    });

    UI.$('#apply-plan').addEventListener('click', async function () {
        if (!lastPlan.length) return;
        UI.$('#apply-plan').disabled = true;
        try {
            var applied = await Tools.applyPlan(lastPlan);
            UI.addMessage('tool', 'Applied:\n' + applied.join('\n'));
            UI.toast('Applied ' + applied.length + ' step' + (applied.length === 1 ? '' : 's'));
            UI.clearPlan();
            lastPlan = [];
        } catch (e) {
            UI.addMessage('error', 'Apply failed: ' + e.message);
        } finally {
            UI.$('#apply-plan').disabled = false;
        }
    });

    UI.$('#discard-plan').addEventListener('click', function () {
        UI.clearPlan();
        lastPlan = [];
    });

    function _short(obj) {
        try {
            var s = typeof obj === 'string' ? obj : JSON.stringify(obj);
            return s.length > 140 ? s.slice(0, 140) + '…' : s;
        } catch (e) { return String(obj); }
    }

    // Boot: try to ping host so we know the bridge is alive.
    Host.ping().then(function () {
        UI.toast('Connected to Premiere');
        refreshClips();
    }).catch(function (e) {
        UI.addMessage('error', 'Host bridge unavailable: ' + e.message);
    });
})();
