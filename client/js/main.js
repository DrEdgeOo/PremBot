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

    // --- Effects tab ---
    var seqClips    = { video: [], audio: [] };
    var selectedKey = null;
    var selectedClip = null;

    function setSelected(clip, key) {
        selectedClip = clip;
        selectedKey  = key;
        var label = !clip ? 'No clip selected'
            : 'Selected: ' + (clip.trackKind === 'audio' ? 'A' : 'V') + (clip.trackIndex + 1) +
              ' #' + clip.clipIndex + ' - ' + clip.name;
        UI.$('#seq-selected').textContent = label;
        UI.renderSequenceClips(seqClips, selectedKey, setSelected);
    }

    async function refreshSeqClips() {
        try {
            seqClips = await Host.listSequenceClips();
            // Drop stale selection if the clip no longer exists at that key.
            var stillThere = (function () {
                if (!selectedKey) return false;
                var groups = [seqClips.video || [], seqClips.audio || []];
                for (var g = 0; g < groups.length; g++) {
                    for (var i = 0; i < groups[g].length; i++) {
                        var c = groups[g][i];
                        if ((c.trackKind + ':' + c.trackIndex + ':' + c.clipIndex) === selectedKey) {
                            selectedClip = c;
                            return true;
                        }
                    }
                }
                return false;
            })();
            if (!stillThere) { selectedClip = null; selectedKey = null; }
            UI.renderSequenceClips(seqClips, selectedKey, setSelected);
            UI.$('#seq-selected').textContent = selectedClip
                ? ('Selected: ' + (selectedClip.trackKind === 'audio' ? 'A' : 'V') + (selectedClip.trackIndex + 1) +
                   ' #' + selectedClip.clipIndex + ' - ' + selectedClip.name)
                : 'No clip selected';
        } catch (e) {
            UI.toast('Failed to list timeline clips: ' + e.message);
        }
    }
    UI.$('#refresh-seq-clips').addEventListener('click', refreshSeqClips);

    function _needSelection() {
        if (!selectedClip) { UI.toast('Pick a clip from the timeline list first.'); return false; }
        return true;
    }

    UI.$('#fx-apply-gain').addEventListener('click', async function () {
        if (!_needSelection()) return;
        if (selectedClip.trackKind !== 'audio') { UI.toast('Gain only applies to audio clips.'); return; }
        var dB = Number(UI.$('#fx-gain-db').value);
        try {
            await Host.setClipAudioGain(selectedClip.trackIndex, selectedClip.clipIndex, dB);
            UI.toast('Gain set to ' + dB + ' dB');
        } catch (e) { UI.toast('Gain failed: ' + e.message); }
    });

    UI.$('#fx-apply-fade').addEventListener('click', async function () {
        if (!_needSelection()) return;
        if (selectedClip.trackKind !== 'audio') { UI.toast('Fades only apply to audio clips.'); return; }
        var side = UI.$('#fx-fade-side').value;
        var dur  = Number(UI.$('#fx-fade-dur').value);
        try {
            await Host.addAudioFade(selectedClip.trackIndex, selectedClip.clipIndex, side, dur);
            UI.toast('Fade ' + side + ' ' + dur + 's added');
        } catch (e) { UI.toast('Fade failed: ' + e.message); }
    });

    UI.$('#fx-pick-preset').addEventListener('click', function () {
        UI.$('#fx-preset-file').click();
    });
    UI.$('#fx-preset-file').addEventListener('change', function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (f && f.path) UI.$('#fx-preset-path').value = f.path;
    });
    UI.$('#fx-apply-preset').addEventListener('click', async function () {
        if (!_needSelection()) return;
        var path = UI.$('#fx-preset-path').value.trim();
        if (!path) { UI.toast('Pick a .prfpset file first.'); return; }
        try {
            await Host.applyClipPreset(selectedClip.trackKind, selectedClip.trackIndex, selectedClip.clipIndex, path);
            UI.toast('Preset applied');
        } catch (e) { UI.toast('Preset failed: ' + e.message); }
    });

    UI.$('#fx-apply-trans').addEventListener('click', async function () {
        if (!_needSelection()) return;
        var edge = UI.$('#fx-trans-edge').value;
        var name = UI.$('#fx-trans-name').value.trim();
        var dur  = Number(UI.$('#fx-trans-dur').value);
        try {
            await Host.addTransition(selectedClip.trackKind, selectedClip.trackIndex, selectedClip.clipIndex, edge, dur, name);
            UI.toast('Transition added');
        } catch (e) { UI.toast('Transition failed: ' + e.message); }
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
