// UI primitives: tab switching, message bubbles, plan rendering, toasts, clip rows.
var UI = (function () {
    function $(sel)   { return document.querySelector(sel); }
    function $$(sel)  { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

    function switchTab(name) {
        $$('.tabs button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
        $$('.tab').forEach(function (t) { t.classList.toggle('hidden', t.id !== 'tab-' + name); });
    }

    function addMessage(kind, text) {
        var el = document.createElement('div');
        el.className = 'msg ' + kind;
        el.textContent = text;
        $('#messages').appendChild(el);
        $('#messages').scrollTop = $('#messages').scrollHeight;
        return el;
    }

    function toast(text, ms) {
        var t = $('#toast');
        t.textContent = text;
        t.classList.add('show');
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.classList.remove('show'); }, ms || 2400);
    }

    function renderClips(clips, transcripts, busyPath) {
        var wrap = $('#clips');
        wrap.innerHTML = '';
        if (!clips || !clips.length) {
            wrap.innerHTML = '<div class="msg">No clips in project. Import some footage in Premiere, then click Refresh.</div>';
            return;
        }
        clips.forEach(function (c) {
            var row = document.createElement('div');
            row.className = 'clip-row';
            var status = transcripts[c.path] ? 'transcribed' : 'pending';
            var label  = transcripts[c.path] ? 'transcribed' : (busyPath === c.path ? 'transcribing…' : 'pending');
            row.innerHTML =
                '<span class="name" title="' + c.path + '">' + c.name + '</span>' +
                '<span class="status ' + status + '">' + label + '</span>';
            wrap.appendChild(row);
        });
    }

    function renderPlan(plan) {
        var box = $('#plan');
        var ol  = $('#plan-list');
        ol.innerHTML = '';
        if (!plan || !plan.length) { box.classList.add('hidden'); return; }
        plan.forEach(function (step) {
            var li = document.createElement('li');
            if (step.kind === 'clear_sequence') {
                li.textContent = 'Clear active sequence';
            } else if (step.kind === 'add_segment') {
                li.textContent =
                    'Insert "' + step.clip_name + '" [' +
                    step.source_in.toFixed(2) + 's-' + step.source_out.toFixed(2) + 's] @ timeline ' +
                    step.timeline_start.toFixed(2) + 's (V' + (step.track + 1) + ')';
            } else if (step.kind === 'set_audio_gain') {
                li.textContent = 'Set gain ' + step.db + ' dB on A' + (step.track_index + 1) + ' clip ' + step.clip_index;
            } else if (step.kind === 'add_audio_fade') {
                li.textContent = 'Fade ' + step.side + ' ' + step.duration_sec + 's on A' + (step.track_index + 1) + ' clip ' + step.clip_index;
            } else if (step.kind === 'apply_clip_preset') {
                var label = step.track_kind === 'audio' ? 'A' : 'V';
                li.textContent = 'Apply preset on ' + label + (step.track_index + 1) + ' clip ' + step.clip_index + ' (' + step.preset_path + ')';
            } else if (step.kind === 'add_transition') {
                var tlabel = step.track_kind === 'audio' ? 'A' : 'V';
                li.textContent = (step.transition_name || 'Transition') + ' ' + step.duration_sec + 's at ' +
                    step.edge + ' of ' + tlabel + (step.track_index + 1) + ' clip ' + step.clip_index;
            } else {
                li.textContent = JSON.stringify(step);
            }
            ol.appendChild(li);
        });
        box.classList.remove('hidden');
    }

    function clearPlan() { $('#plan-list').innerHTML = ''; $('#plan').classList.add('hidden'); }

    function renderSequenceClips(seqClips, selected, onSelect) {
        var wrap = $('#seq-clips');
        wrap.innerHTML = '';
        var all = [];
        ['video', 'audio'].forEach(function (kind) {
            (seqClips[kind] || []).forEach(function (c) { all.push(c); });
        });
        if (!all.length) {
            wrap.innerHTML = '<div class="msg">No clips on the active sequence. Add some via the Chat tab or in Premiere, then click Refresh.</div>';
            return;
        }
        all.forEach(function (c) {
            var row = document.createElement('div');
            row.className = 'clip-row';
            var key = c.trackKind + ':' + c.trackIndex + ':' + c.clipIndex;
            if (selected === key) row.classList.add('selected');
            var label = (c.trackKind === 'audio' ? 'A' : 'V') + (c.trackIndex + 1) + ' #' + c.clipIndex;
            row.innerHTML =
                '<span class="name" title="' + c.name + '">' + label + ' - ' + c.name + '</span>' +
                '<span class="status">' + c.start.toFixed(2) + 's-' + c.end.toFixed(2) + 's</span>';
            row.addEventListener('click', function () { onSelect(c, key); });
            wrap.appendChild(row);
        });
    }

    function getMode() {
        var checked = document.querySelector('input[name="mode"]:checked');
        return checked ? checked.value : 'plan';
    }

    return {
        $: $, $$: $$,
        switchTab:   switchTab,
        addMessage:  addMessage,
        toast:       toast,
        renderClips:         renderClips,
        renderSequenceClips: renderSequenceClips,
        renderPlan:          renderPlan,
        clearPlan:           clearPlan,
        getMode:             getMode
    };
})();
