// PremBot ExtendScript host - bridges the panel to Premiere via QE / DOM scripting.

// Minimal JSON.stringify polyfill (ASCII-only). ExtendScript lacks native JSON.
if (typeof JSON !== 'object') { JSON = {}; }
if (typeof JSON.stringify !== 'function') {
    JSON.stringify = (function () {
        function quote(s) {
            var out = '"';
            for (var i = 0; i < s.length; i++) {
                var c = s.charAt(i);
                var code = s.charCodeAt(i);
                if (c === '"' || c === '\\') { out += '\\' + c; }
                else if (c === '\b') { out += '\\b'; }
                else if (c === '\f') { out += '\\f'; }
                else if (c === '\n') { out += '\\n'; }
                else if (c === '\r') { out += '\\r'; }
                else if (c === '\t') { out += '\\t'; }
                else if (code < 32 || code > 126) {
                    var hex = code.toString(16);
                    while (hex.length < 4) hex = '0' + hex;
                    out += '\\u' + hex;
                } else {
                    out += c;
                }
            }
            return out + '"';
        }
        function str(value) {
            if (value === null || value === undefined) return 'null';
            var t = typeof value;
            if (t === 'string')  return quote(value);
            if (t === 'number')  return isFinite(value) ? String(value) : 'null';
            if (t === 'boolean') return String(value);
            if (value instanceof Array) {
                var parts = [];
                for (var i = 0; i < value.length; i++) {
                    parts.push(str(value[i]) || 'null');
                }
                return '[' + parts.join(',') + ']';
            }
            if (t === 'object') {
                var members = [];
                for (var k in value) {
                    if (value.hasOwnProperty(k)) {
                        var v = str(value[k]);
                        if (v !== undefined) members.push(quote(k) + ':' + v);
                    }
                }
                return '{' + members.join(',') + '}';
            }
            return undefined;
        }
        return function (value) { return str(value); };
    })();
}

var PremBot = (function () {
    function ok(data)   { return JSON.stringify({ ok: true,  data: data }); }
    function err(msg)   { return JSON.stringify({ ok: false, error: String(msg) }); }
    function _safe(fn)  { try { return fn(); } catch (e) { return err(e.message || e); } }

    function _walkClips(rootItem, out) {
        for (var i = 0; i < rootItem.children.numItems; i++) {
            var child = rootItem.children[i];
            if (child.type === 2) {
                _walkClips(child, out);
            } else if (child.type === 1 && typeof child.getMediaPath === 'function') {
                var path = '';
                try { path = child.getMediaPath() || ''; } catch (e) {}
                if (path) {
                    out.push({
                        nodeId:   child.nodeId,
                        name:     child.name,
                        path:     path,
                        duration: null
                    });
                }
            }
        }
    }

    function _findByNodeId(rootItem, nodeId) {
        for (var i = 0; i < rootItem.children.numItems; i++) {
            var child = rootItem.children[i];
            if (String(child.nodeId) === String(nodeId)) return child;
            if (child.type === 2) {
                var found = _findByNodeId(child, nodeId);
                if (found) return found;
            }
        }
        return null;
    }

    function _requireSeq() {
        var seq = app.project.activeSequence;
        if (!seq) throw new Error('No active sequence - create one in Premiere first.');
        return seq;
    }

    function _trackGroup(seq, kind) {
        if (kind === 'audio') return seq.audioTracks;
        return seq.videoTracks;
    }

    function _resolveClip(kind, trackIndex, clipIndex) {
        var seq = _requireSeq();
        var group = _trackGroup(seq, kind);
        if (trackIndex < 0 || trackIndex >= group.numTracks) {
            throw new Error('Track index out of range: ' + trackIndex);
        }
        var track = group[trackIndex];
        if (clipIndex < 0 || clipIndex >= track.clips.numItems) {
            throw new Error('Clip index out of range on ' + kind + ' track ' + trackIndex + ': ' + clipIndex);
        }
        return { seq: seq, track: track, clip: track.clips[clipIndex] };
    }

    // Find a component on a TrackItem by displayName (case-insensitive).
    function _findComponent(clip, names) {
        if (!clip.components) return null;
        for (var i = 0; i < clip.components.numItems; i++) {
            var c = clip.components[i];
            var dn = String(c.displayName || '').toLowerCase();
            for (var j = 0; j < names.length; j++) {
                if (dn === names[j].toLowerCase()) return c;
            }
        }
        return null;
    }

    function _findProperty(component, names) {
        if (!component || !component.properties) return null;
        for (var i = 0; i < component.properties.numItems; i++) {
            var p = component.properties[i];
            var dn = String(p.displayName || '').toLowerCase();
            for (var j = 0; j < names.length; j++) {
                if (dn === names[j].toLowerCase()) return p;
            }
        }
        return null;
    }

    function _dbToLinear(dB) {
        if (dB <= -96) return 0;
        return Math.pow(10, Number(dB) / 20);
    }

    return {
        ping: function () { return ok('pong'); },

        listProjectClips: function () {
            return _safe(function () {
                if (!app.project) return err('No project open');
                var clips = [];
                _walkClips(app.project.rootItem, clips);
                return ok(clips);
            });
        },

        getActiveSequenceInfo: function () {
            return _safe(function () {
                var seq = app.project.activeSequence;
                if (!seq) return ok(null);
                return ok({
                    name:        seq.name,
                    id:          seq.sequenceID,
                    videoTracks: seq.videoTracks.numTracks,
                    audioTracks: seq.audioTracks.numTracks
                });
            });
        },

        // Enumerate timeline clips so callers can address them by track+index.
        listSequenceClips: function () {
            return _safe(function () {
                var seq = _requireSeq();
                var out = { video: [], audio: [] };
                function dump(group, kind) {
                    for (var ti = 0; ti < group.numTracks; ti++) {
                        var track = group[ti];
                        for (var ci = 0; ci < track.clips.numItems; ci++) {
                            var clip = track.clips[ci];
                            var startSec = 0, endSec = 0;
                            try { startSec = clip.start.seconds; } catch (e) {}
                            try { endSec   = clip.end.seconds; }   catch (e) {}
                            out[kind].push({
                                trackKind:  kind,
                                trackIndex: ti,
                                clipIndex:  ci,
                                name:       clip.name,
                                start:      startSec,
                                end:        endSec
                            });
                        }
                    }
                }
                dump(seq.videoTracks, 'video');
                dump(seq.audioTracks, 'audio');
                return ok(out);
            });
        },

        clearActiveSequence: function () {
            return _safe(function () {
                var seq = _requireSeq();
                var i, j, t;
                for (i = 0; i < seq.videoTracks.numTracks; i++) {
                    t = seq.videoTracks[i];
                    for (j = t.clips.numItems - 1; j >= 0; j--) t.clips[j].remove(false, false);
                }
                for (i = 0; i < seq.audioTracks.numTracks; i++) {
                    t = seq.audioTracks[i];
                    for (j = t.clips.numItems - 1; j >= 0; j--) t.clips[j].remove(false, false);
                }
                return ok(true);
            });
        },

        addSegment: function (nodeId, sourceIn, sourceOut, timelineStart, track) {
            return _safe(function () {
                var seq = _requireSeq();
                var item = _findByNodeId(app.project.rootItem, nodeId);
                if (!item) return err('Clip not found for nodeId ' + nodeId);

                try { item.setInPoint(Number(sourceIn),  4); } catch (e) {}
                try { item.setOutPoint(Number(sourceOut), 4); } catch (e) {}

                var t = new Time();
                t.seconds = Number(timelineStart);

                var trackIndex = Number(track || 0);
                if (trackIndex >= seq.videoTracks.numTracks) return err('Video track out of range');

                seq.videoTracks[trackIndex].insertClip(item, t);
                return ok({ name: item.name, at: Number(timelineStart) });
            });
        },

        // Set the Volume "Level" on an audio clip. dB is the new gain.
        setClipAudioGain: function (trackIndex, clipIndex, dB) {
            return _safe(function () {
                var r = _resolveClip('audio', Number(trackIndex), Number(clipIndex));
                var volume = _findComponent(r.clip, ['Volume', 'Audio Levels']);
                if (!volume) return err('No Volume component on clip "' + r.clip.name + '"');
                var level = _findProperty(volume, ['Level', 'Bypass']);
                if (!level || String(level.displayName).toLowerCase() !== 'level') {
                    level = _findProperty(volume, ['Level']);
                }
                if (!level) return err('No Level property on Volume component');
                try { level.setTimeVarying(false); } catch (e) {}
                var lin = _dbToLinear(Number(dB));
                level.setValue(lin, true);
                return ok({ trackIndex: Number(trackIndex), clipIndex: Number(clipIndex), dB: Number(dB), linear: lin });
            });
        },

        // Add an audio fade by keyframing Volume->Level at the clip edge.
        // side: 'in' or 'out'. durationSec is the fade length.
        addAudioFade: function (trackIndex, clipIndex, side, durationSec) {
            return _safe(function () {
                var r = _resolveClip('audio', Number(trackIndex), Number(clipIndex));
                var volume = _findComponent(r.clip, ['Volume', 'Audio Levels']);
                if (!volume) return err('No Volume component on clip "' + r.clip.name + '"');
                var level = _findProperty(volume, ['Level']);
                if (!level) return err('No Level property on Volume component');

                var startSec = r.clip.start.seconds;
                var endSec   = r.clip.end.seconds;
                var dur      = Math.max(0.01, Number(durationSec) || 1);
                var current  = 1.0;
                try { current = level.getValue(); } catch (e) {}
                if (!isFinite(current) || current <= 0) current = 1.0;

                var edgeTime  = (side === 'out') ? endSec - dur : startSec;
                var innerTime = (side === 'out') ? endSec       : startSec + dur;
                if (side === 'out' && edgeTime < startSec)  edgeTime  = startSec;
                if (side === 'in'  && innerTime > endSec)   innerTime = endSec;

                try { level.setTimeVarying(true); } catch (e) {}

                function tAt(sec) { var t = new Time(); t.seconds = sec; return t; }

                // Anchor inner keyframe at current level, edge keyframe at silence.
                try { level.addKey(tAt(innerTime)); } catch (e) {}
                try { level.setValueAtKey(tAt(innerTime), current, true); } catch (e) {}
                try { level.addKey(tAt(edgeTime)); } catch (e) {}
                try { level.setValueAtKey(tAt(edgeTime), 0.0, true); } catch (e) {}

                return ok({ side: side, durationSec: dur, edgeSec: edgeTime, innerSec: innerTime });
            });
        },

        // Apply a .prfpset preset (e.g. a Lumetri Look) to a timeline clip.
        applyClipPreset: function (trackKind, trackIndex, clipIndex, presetPath) {
            return _safe(function () {
                var kind = (trackKind === 'audio') ? 'audio' : 'video';
                var r = _resolveClip(kind, Number(trackIndex), Number(clipIndex));
                if (!presetPath) return err('Missing preset path');
                var f = new File(String(presetPath));
                if (!f.exists) return err('Preset file not found: ' + presetPath);
                if (typeof r.clip.applyPreset !== 'function') {
                    return err('applyPreset not supported on this clip (Premiere too old?)');
                }
                var rc = r.clip.applyPreset(f);
                return ok({ clip: r.clip.name, presetPath: String(presetPath), result: !!rc });
            });
        },

        // Add a transition at a clip edge using the QE DOM.
        // edge: 'start' or 'end'. transitionName defaults to 'Cross Dissolve'.
        addTransition: function (trackKind, trackIndex, clipIndex, edge, durationSec, transitionName) {
            return _safe(function () {
                var kind = (trackKind === 'audio') ? 'audio' : 'video';
                _resolveClip(kind, Number(trackIndex), Number(clipIndex)); // validate

                if (typeof app.enableQE === 'function') app.enableQE();
                if (typeof qe === 'undefined' || !qe.project) {
                    return err('QE DOM unavailable in this Premiere version.');
                }

                var qeSeq = qe.project.getActiveSequence();
                if (!qeSeq) return err('QE: no active sequence');

                var qeTrack = (kind === 'audio')
                    ? qeSeq.getAudioTrackAt(Number(trackIndex))
                    : qeSeq.getVideoTrackAt(Number(trackIndex));
                if (!qeTrack) return err('QE: track not found');

                var qeClip = qeTrack.getItemAt(Number(clipIndex));
                if (!qeClip) return err('QE: clip not found at index ' + clipIndex);

                var wanted = String(transitionName || (kind === 'audio' ? 'Constant Power' : 'Cross Dissolve'));

                // Build "HH:MM:SS:FF" duration from seconds.
                var dur = Math.max(0.1, Number(durationSec) || 1);
                var fr = 24;
                try { fr = qeSeq.videoFrameRate ? Number(qeSeq.videoFrameRate) : 24; } catch (e) {}
                if (!isFinite(fr) || fr <= 0) fr = 24;
                var totalFrames = Math.round(dur * fr);
                var ff = totalFrames % fr;
                var totalSec = Math.floor(totalFrames / fr);
                var ss = totalSec % 60;
                var mm = Math.floor(totalSec / 60) % 60;
                var hh = Math.floor(totalSec / 3600);
                function pad(n) { return (n < 10 ? '0' : '') + n; }
                var tc = pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);

                var alignToBeginning = (edge !== 'end');

                // Try several known QE API surfaces. Premiere has changed these
                // method names across versions, so we attempt each in turn.
                function _listTransitions() {
                    var list = null;
                    try {
                        if (kind === 'audio') {
                            if (typeof qe.project.getAudioTransitions === 'function')        list = qe.project.getAudioTransitions();
                            else if (typeof qe.project.getAudioTransitionList === 'function') list = qe.project.getAudioTransitionList();
                        } else {
                            if (typeof qe.project.getVideoTransitions === 'function')        list = qe.project.getVideoTransitions();
                            else if (typeof qe.project.getVideoTransitionList === 'function') list = qe.project.getVideoTransitionList();
                        }
                    } catch (e) {}
                    return list;
                }

                var attempts = [];
                var list = _listTransitions();
                var picked = null;
                if (list && list.length) {
                    for (var i = 0; i < list.length; i++) {
                        if (String(list[i].name) === wanted) { picked = list[i]; break; }
                    }
                    if (!picked) picked = list[0];
                } else {
                    attempts.push('list: no get(Video|Audio)Transitions[List] method found');
                }

                // Permutations to try. Some Premiere builds differ on receiver
                // (clip vs track), arg arity (3/4/5/6), alignment type (bool vs int),
                // and whether the first arg is a transition object or a name string.
                function _try(label, fn) {
                    try { fn(); return true; }
                    catch (e) { attempts.push(label + ': ' + (e.message || e)); return false; }
                }

                var alignInt = (edge === 'end') ? 2 : 1; // 0=center, 1=start, 2=end (guess)
                var done = false;

                if (picked) {
                    done = _try('clip.add(obj, bool, tc)',                 function () { qeClip.addTransition(picked, alignToBeginning, tc); });
                    if (!done) done = _try('clip.add(obj, bool, tc, null, qeClip, false)',  function () { qeClip.addTransition(picked, alignToBeginning, tc, null, qeClip, false); });
                    if (!done) done = _try('clip.add(obj, bool, tc, null, qeClip, alignInt)', function () { qeClip.addTransition(picked, alignToBeginning, tc, null, qeClip, alignInt); });
                    if (!done) done = _try('track.add(obj, bool, tc)',              function () { qeTrack.addTransition(picked, alignToBeginning, tc); });
                    if (!done) done = _try('track.add(obj, bool, tc, null, qeClip, false)', function () { qeTrack.addTransition(picked, alignToBeginning, tc, null, qeClip, false); });
                    if (!done) done = _try('track.add(obj, bool, tc, null, qeClip, alignInt)', function () { qeTrack.addTransition(picked, alignToBeginning, tc, null, qeClip, alignInt); });
                }

                if (!done) done = _try('clip.add(name, bool, tc)',                  function () { qeClip.addTransition(wanted, alignToBeginning, tc); });
                if (!done) done = _try('clip.add(name, bool, tc, null, qeClip, false)', function () { qeClip.addTransition(wanted, alignToBeginning, tc, null, qeClip, false); });
                if (!done) done = _try('track.add(name, bool, tc)',                 function () { qeTrack.addTransition(wanted, alignToBeginning, tc); });
                if (!done) done = _try('track.add(name, bool, tc, null, qeClip, false)', function () { qeTrack.addTransition(wanted, alignToBeginning, tc, null, qeClip, false); });

                if (!done) {
                    var fn = (kind === 'audio') ? qeClip.addAudioTransition : qeClip.addVideoTransition;
                    if (typeof fn === 'function') {
                        done = _try('clip.addKindTransition(name, bool, tc)', function () { fn.call(qeClip, wanted, alignToBeginning, tc); });
                    } else {
                        attempts.push('clip.addKindTransition: not a function');
                    }
                }

                if (done) return ok({ clip: qeClip.name, edge: edge, durationSec: dur, transition: picked ? (picked.name || wanted) : wanted, attempts: attempts.length });

                return err('Could not add transition. Attempts: ' + attempts.join(' | '));
            });
        },

        // Diagnostic: dump QE object surface so we can see what's actually exposed.
        debugQE: function () {
            return _safe(function () {
                if (typeof app.enableQE === 'function') app.enableQE();
                if (typeof qe === 'undefined' || !qe.project) {
                    return err('QE DOM unavailable in this Premiere version.');
                }
                function listKeys(obj) {
                    var keys = [];
                    if (!obj) return keys;
                    for (var k in obj) {
                        try { keys.push(k + ' (' + (typeof obj[k]) + ')'); } catch (e) {}
                    }
                    return keys.sort();
                }
                var qeSeq = null;
                try { qeSeq = qe.project.getActiveSequence(); } catch (e) {}
                var firstTrack = null, firstClip = null;
                try {
                    if (qeSeq) firstTrack = qeSeq.getVideoTrackAt(0);
                    if (firstTrack) firstClip = firstTrack.getItemAt(0);
                } catch (e) {}
                return ok({
                    qe_project_keys:  listKeys(qe.project),
                    qe_seq_keys:      listKeys(qeSeq),
                    qe_track_keys:    listKeys(firstTrack),
                    qe_clip_keys:     listKeys(firstClip)
                });
            });
        }
    };
})();

// CSInterface evalScript can only call top-level functions, so expose them here.
function pbPing()                                           { return PremBot.ping(); }
function pbListProjectClips()                               { return PremBot.listProjectClips(); }
function pbGetActiveSequenceInfo()                          { return PremBot.getActiveSequenceInfo(); }
function pbListSequenceClips()                              { return PremBot.listSequenceClips(); }
function pbClearActiveSequence()                            { return PremBot.clearActiveSequence(); }
function pbAddSegment(nodeId, sIn, sOut, tStart, track)     { return PremBot.addSegment(nodeId, sIn, sOut, tStart, track); }
function pbSetClipAudioGain(tIdx, cIdx, dB)                 { return PremBot.setClipAudioGain(tIdx, cIdx, dB); }
function pbAddAudioFade(tIdx, cIdx, side, dur)              { return PremBot.addAudioFade(tIdx, cIdx, side, dur); }
function pbApplyClipPreset(kind, tIdx, cIdx, path)          { return PremBot.applyClipPreset(kind, tIdx, cIdx, path); }
function pbAddTransition(kind, tIdx, cIdx, edge, dur, name) { return PremBot.addTransition(kind, tIdx, cIdx, edge, dur, name); }
function pbDebugQE()                                        { return PremBot.debugQE(); }
