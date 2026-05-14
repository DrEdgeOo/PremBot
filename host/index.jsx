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

        // Transitions are not supported in this Premiere version: the QE
        // addTransition call is a silent no-op (verified by numTransitions
        // count not changing). Return a clear error so callers know to add
        // transitions manually in Premiere instead of being told it worked.
        addTransition: function () {
            return err('Transitions are not scriptable in this Premiere build - the QE addTransition API has been deprecated. Add transitions manually in Premiere (Ctrl+D for the default at a cut), or use the Effects panel.');
        },

        // Change the playback speed of a timeline clip via QE.
        // speedPercent: 100 = normal, 50 = half-speed, 200 = double-speed.
        setClipSpeed: function (trackKind, trackIndex, clipIndex, speedPercent) {
            return _safe(function () {
                var kind = (trackKind === 'audio') ? 'audio' : 'video';
                _resolveClip(kind, Number(trackIndex), Number(clipIndex));

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

                var pct = Number(speedPercent);
                if (!isFinite(pct) || pct <= 0) return err('speedPercent must be > 0 (100 = normal speed)');
                if (typeof qeClip.setSpeed !== 'function') return err('setSpeed not available on this clip');

                var before = Number(qeClip.speed) || 100;
                qeClip.setSpeed(pct);
                try { if (typeof qeSeq.flushCache === 'function') qeSeq.flushCache(); } catch (e) {}
                var after = before;
                try {
                    var freshTrack = (kind === 'audio') ? qe.project.getActiveSequence().getAudioTrackAt(Number(trackIndex)) : qe.project.getActiveSequence().getVideoTrackAt(Number(trackIndex));
                    after = Number(freshTrack.getItemAt(Number(clipIndex)).speed) || before;
                } catch (e) {}

                return ok({
                    clip: qeClip.name, speed_before: before, speed_after: after,
                    note: (Math.abs(after - pct) < 0.5) ? 'Speed updated.' : 'setSpeed call returned but clip.speed did not match requested value.'
                });
            });
        },

        // Diagnostic: probe the DOM TrackItem (NOT QE) for methods we can use.
        // DOM is more stable than QE across Premiere versions.
        debugClip: function (trackKind, trackIndex, clipIndex) {
            return _safe(function () {
                var kind = (trackKind === 'audio') ? 'audio' : 'video';
                var r = _resolveClip(kind, Number(trackIndex || 0), Number(clipIndex || 0));
                function listKeys(obj) {
                    var keys = [];
                    if (!obj) return keys;
                    for (var k in obj) { try { keys.push(k + ' (' + (typeof obj[k]) + ')'); } catch (e) {} }
                    return keys.sort();
                }
                function probeMethods(obj, names) {
                    var found = [];
                    if (!obj) return found;
                    for (var i = 0; i < names.length; i++) {
                        try { if (typeof obj[names[i]] === 'function') found.push(names[i]); } catch (e) {}
                    }
                    return found;
                }
                var clipProbe = [
                    'applyPreset','remove','move','setName','setSelected','isSelected',
                    'getMatchName','setSpeed','setInPoint','setOutPoint','duplicate',
                    'addVideoEffect','addAudioEffect','setColorLabel','setDisabled'
                ];
                var componentsInfo = [];
                try {
                    if (r.clip.components) {
                        for (var ci = 0; ci < r.clip.components.numItems; ci++) {
                            var c = r.clip.components[ci];
                            componentsInfo.push({
                                displayName: String(c.displayName || ''),
                                matchName:   String(c.matchName || ''),
                                numProps:    c.properties ? c.properties.numItems : 0
                            });
                        }
                    }
                } catch (e) {}
                return ok({
                    clip_dom_keys:    listKeys(r.clip),
                    clip_dom_methods: probeMethods(r.clip, clipProbe),
                    clip_components:  componentsInfo
                });
            });
        },

        // Diagnostic: dump QE object surface and probe for transition methods.
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
                // Methods are usually non-enumerable on host objects, so probe by name.
                function probeMethods(obj, names) {
                    var found = [];
                    if (!obj) return found;
                    for (var i = 0; i < names.length; i++) {
                        try {
                            if (typeof obj[names[i]] === 'function') found.push(names[i]);
                        } catch (e) {}
                    }
                    return found;
                }
                var projectProbe = [
                    'getActiveSequence','getVideoTransitions','getAudioTransitions',
                    'getVideoTransitionList','getAudioTransitionList',
                    'getVideoEffectList','getAudioEffectList','getVideoEffects','getAudioEffects'
                ];
                var seqProbe = [
                    'getVideoTrackAt','getAudioTrackAt','getTransitionAt','numTransitions',
                    'getInPoint','getOutPoint','razor','flushCache'
                ];
                var trackProbe = [
                    'getItemAt','getTransitionAt','addTransition','addVideoTransition','addAudioTransition',
                    'removeItems','insertClip','setName','setMute','setLock'
                ];
                var clipProbe = [
                    'addTransition','addVideoTransition','addAudioTransition',
                    'remove','move','setSpeed','setName','select','deselect',
                    'getComponentAt','addAudioEffect','addVideoEffect','applyPreset'
                ];

                var qeSeq = null;
                try { qeSeq = qe.project.getActiveSequence(); } catch (e) {}
                var firstTrack = null, firstClip = null;
                try {
                    if (qeSeq) firstTrack = qeSeq.getVideoTrackAt(0);
                    if (firstTrack) firstClip = firstTrack.getItemAt(0);
                } catch (e) {}

                // Probe transition list: dig into the opaque transition objects.
                var videoTransitionsRaw = null;
                var videoTransitionsShape = null;
                try {
                    var getList = qe.project.getVideoTransitionList || qe.project.getVideoTransitions;
                    if (typeof getList === 'function') {
                        var vt = getList.call(qe.project);
                        videoTransitionsRaw = { length: (vt && vt.length) || 0, kind: typeof vt };
                        if (vt && vt.length) {
                            var first = vt[0];
                            var firstJson = null;
                            try { if (typeof first.toJSON === 'function') firstJson = first.toJSON(); } catch (e) { firstJson = 'toJSON_error: ' + (e.message || e); }
                            var firstStringified = null;
                            try { firstStringified = String(first); } catch (e) {}
                            videoTransitionsShape = {
                                first_keys:    listKeys(first),
                                first_methods: probeMethods(first, ['getName','getMatchName','getDisplayName','getCategory','toJSON','toString']),
                                first_toJSON:  firstJson,
                                first_string:  firstStringified
                            };
                        }
                    } else {
                        videoTransitionsRaw = { error: 'no getVideoTransitionList method' };
                    }
                } catch (e) { videoTransitionsRaw = { error: String(e.message || e) }; }

                // (Previous versions of this diagnostic invoked addTransition with
                // many arg combinations and accidentally inserted real transitions
                // on the timeline. We confirmed the signature is addTransition(neighborClip)
                // and removed the destructive probes.)

                return ok({
                    qe_project_keys:    listKeys(qe.project),
                    qe_project_methods: probeMethods(qe.project, projectProbe),
                    qe_seq_keys:        listKeys(qeSeq),
                    qe_seq_methods:     probeMethods(qeSeq, seqProbe),
                    qe_track_keys:      listKeys(firstTrack),
                    qe_track_methods:   probeMethods(firstTrack, trackProbe),
                    qe_clip_keys:       listKeys(firstClip),
                    qe_clip_methods:    probeMethods(firstClip, clipProbe),
                    video_transitions:  videoTransitionsRaw,
                    video_transitions_shape: videoTransitionsShape
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
function pbAddTransition()                                  { return PremBot.addTransition(); }
function pbSetClipSpeed(kind, tIdx, cIdx, pct)              { return PremBot.setClipSpeed(kind, tIdx, cIdx, pct); }
function pbDebugQE()                                        { return PremBot.debugQE(); }
function pbDebugClip(kind, tIdx, cIdx)                      { return PremBot.debugClip(kind, tIdx, cIdx); }

// ---- Helper bridge dispatcher ----
//
// The CEP HTTP bridge (client/js/bridge.js) calls into ExtendScript
// via pbRun(toolName, jsonString). We dispatch to a handler keyed by
// toolName and JSON-return the result. JSON arg parsing is wrapped
// in try/catch since ExtendScript's JSON.parse is the polyfill from
// json2.js / the inline polyfill above.
//
// Phase 1 ships only "ping" to verify the round-trip works. Phase 2
// adds the real broken-UXP backfills (trim, split, insert, marker).

function pbRun(toolName, jsonArgs) {
    try {
        var args = {};
        try {
            args = jsonArgs ? JSON.parse(jsonArgs) : {};
        } catch (e) {
            return JSON.stringify({ ok: false, tool: toolName,
                error: "BAD_ARGS_JSON", message: e.message || String(e) });
        }
        var handler = pbHelperHandlers[toolName];
        if (typeof handler !== "function") {
            return JSON.stringify({ ok: false, tool: toolName,
                error: "UNKNOWN_TOOL",
                available: pbHelperToolNames() });
        }
        var result = handler(args);
        if (typeof result === "undefined") result = { ok: true };
        if (!result.ok && result.ok !== false) result.ok = true;
        result.tool = toolName;
        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({ ok: false, tool: toolName,
            error: "HANDLER_THREW",
            message: (e && (e.message || e.toString())) || String(e) });
    }
}

function pbHelperToolNames() {
    var out = [];
    for (var k in pbHelperHandlers) {
        if (pbHelperHandlers.hasOwnProperty(k)) out.push(k);
    }
    return out;
}

var pbHelperHandlers = {
    // Phase 1 verification: round-trips a payload and reports basic
    // host context.
    ping: function (args) {
        var seq = null;
        try {
            if (app.project && app.project.activeSequence) {
                var s = app.project.activeSequence;
                seq = {
                    name: s.name,
                    videoTracks: s.videoTracks ? s.videoTracks.numTracks : null,
                    audioTracks: s.audioTracks ? s.audioTracks.numTracks : null
                };
            }
        } catch (e) {}
        return {
            ok: true,
            echo: args || null,
            extendscript: typeof $ !== "undefined"
                ? ($.version ? $.version : "unknown") : "?",
            host: {
                appName: (app && app.getAppInfo && app.getAppInfo()) || "Premiere",
                version: app && app.version,
                project: app && app.project ? app.project.name : null,
                activeSequence: seq
            }
        };
    },

    // ---- Phase 2: broken-UXP backfills via ExtendScript ----

    // trim_clip: set inPoint / outPoint / start / end on a trackItem.
    // args: { kind: "video"|"audio", trackIndex, clipIndex,
    //         field: "outPoint"|"inPoint"|"start"|"end", newSec }
    // The four fields each take a Time object. For "start"/"end" the
    // time is timeline (sequence) time; for "inPoint"/"outPoint" it's
    // source-media time.
    trim_clip: function (args) {
        var clip = pbHelperGetClip(args.kind, args.trackIndex, args.clipIndex);
        var t = pbHelperTime(args.newSec);
        var field = args.field || "outPoint";
        var before = pbHelperReadClipTimes(clip);
        var result;
        pbBeginUndo("PremBot: trim " + (args.kind || "video")
            + " clip " + args.clipIndex + " " + field);
        try {
            if      (field === "outPoint") clip.outPoint = t;
            else if (field === "inPoint")  clip.inPoint  = t;
            else if (field === "start")    clip.start    = t;
            else if (field === "end")      clip.end      = t;
            else {
                result = { ok: false, error: "UNKNOWN_FIELD", field: field,
                    expected: ["outPoint","inPoint","start","end"] };
            }
            if (!result) result = { ok: true, kind: args.kind || "video",
                trackIndex: args.trackIndex, clipIndex: args.clipIndex,
                field: field, newSec: args.newSec,
                before: before, after: pbHelperReadClipTimes(clip) };
        } finally {
            pbEndUndo();
        }
        return result;
    },

    // split_clip: razor-cut a clip at a timeline second via the QE API.
    // QE's razor signature: razor(Time) - takes a Time OBJECT (not a
    // tick string and not a timecode string). Passing the wrong type
    // returns silently with no error, so verify post-state by counting
    // V1 trackItems before/after.
    split_clip: function (args) {
        try { app.enableQE(); } catch (e) {}
        if (typeof qe === "undefined" || !qe.project) {
            return { ok: false, error: "QE_UNAVAILABLE",
                message: "qe.project is not available even after enableQE()." };
        }
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };

        var domSeq = app.project.activeSequence;
        var v0 = domSeq.videoTracks[0];
        var beforeCount = v0.clips.numItems;

        // QE razor's arg type isn't documented and varies across
        // Premiere versions. Try multiple candidates and report which
        // one actually splits V1.
        var atSec = args.atSec;
        var fps = 30; // assumed - good enough for the timecode form
        try {
            // Sequence's frame rate (Time per frame) via DOM if available.
            // Premiere ExtendScript exposes seq.getSettings().videoFrameRate
            var st = domSeq.getSettings && domSeq.getSettings();
            if (st && st.videoFrameRate && st.videoFrameRate.ticks) {
                var ticksPerFrame = parseFloat(String(st.videoFrameRate.ticks));
                var TPS = 254016000000;
                fps = Math.round(TPS / ticksPerFrame);
            }
        } catch (e) {}
        function pad(n, w) {
            var s = String(Math.floor(n));
            while (s.length < (w || 2)) s = "0" + s;
            return s;
        }
        var h  = Math.floor(atSec / 3600);
        var m  = Math.floor((atSec % 3600) / 60);
        var s  = Math.floor(atSec % 60);
        var fr = Math.round((atSec - Math.floor(atSec)) * fps);

        var t = new Time(); t.seconds = atSec;
        var attempts = [
            ["timecode-colons HH:MM:SS:FF",
                pad(h)+":"+pad(m)+":"+pad(s)+":"+pad(fr)],
            ["timecode-semicolons HH;MM;SS;FF",
                pad(h)+";"+pad(m)+";"+pad(s)+";"+pad(fr)],
            ["seconds-as-number", atSec],
            ["seconds-as-string", String(atSec)],
            ["ticks-as-number", Math.round(atSec * 254016000000)],
            ["ticks-as-string", String(Math.round(atSec * 254016000000))]
        ];

        var tries = [];
        var landed = null;
        pbBeginUndo("PremBot: split at " + atSec + "s");
        try {
            for (var i = 0; i < attempts.length; i++) {
                var label = attempts[i][0];
                var arg   = attempts[i][1];
                var rec = { tried: label, argType: typeof arg };
                if (typeof arg === "string") rec.argValue = arg;
                try {
                    qeSeq.razor(arg);
                    var afterCount = app.project.activeSequence
                        .videoTracks[0].clips.numItems;
                    rec.clipsAfter = afterCount;
                    if (afterCount > beforeCount) {
                        rec.split = true;
                        landed = rec;
                        tries.push(rec);
                        break;
                    } else {
                        rec.split = false;
                    }
                } catch (e) {
                    rec.error = e.message || String(e);
                }
                tries.push(rec);
            }
        } finally {
            pbEndUndo();
        }
        if (landed) {
            return { ok: true, atSec: atSec, fps: fps,
                winning: landed.tried,
                v1ClipsBefore: beforeCount,
                v1ClipsAfter: landed.clipsAfter,
                attempts: tries };
        }
        return { ok: false, error: "RAZOR_NOOP",
            message: "None of the razor signatures landed a cut.",
            atSec: atSec, fps: fps,
            v1ClipsBefore: beforeCount, attempts: tries };
    },

    // insert_clip_from_bin: drop a project bin item onto V<trackIndex+1>
    // (and matching audio) at a timeline second. The UXP createInsert-
    // ProjectItemAction is stubbed; ExtendScript's insertClip works.
    // args: { projectItemName, atSec, trackIndex }
    insert_clip_from_bin: function (args) {
        var seq = app.project.activeSequence;
        if (!seq) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };
        var projItem = pbHelperFindProjectItem(args.projectItemName);
        if (!projItem) return { ok: false, error: "PROJECT_ITEM_NOT_FOUND",
            projectItemName: args.projectItemName };
        var track = seq.videoTracks[args.trackIndex || 0];
        if (!track) return { ok: false, error: "NO_VIDEO_TRACK",
            trackIndex: args.trackIndex };
        var t = pbHelperTime(args.atSec || 0);
        var result;
        pbBeginUndo("PremBot: insert " + args.projectItemName
            + " at " + (args.atSec || 0) + "s");
        try {
            track.insertClip(projItem, t);
            result = { ok: true, projectItemName: args.projectItemName,
                atSec: args.atSec, trackIndex: args.trackIndex };
        } finally {
            pbEndUndo();
        }
        return result;
    },

    // ---- Color grading: Lumetri Color via QE DOM + DOM property writes ----
    //
    // Applying an effect by name is QE-DOM-only (T3) - UXP has no API for
    // it and never will. Once Lumetri Color exists on a clip, its
    // parameters surface as a flat properties[] list on the corresponding
    // component, and `property.setValue(value, updateUI)` works reliably
    // from ExtendScript on Premiere 26.2.2.

    apply_lumetri: function (args) {
        var clip = pbHelperResolveClip(args);
        if (!clip) return { ok: false, error: "CLIP_NOT_FOUND",
            message: pbHelperResolveExplain(args) };

        // Idempotent: skip if Lumetri Color is already on this clip.
        var existing = pbHelperFindLumetriComponent(clip);
        if (existing) {
            return { ok: true, alreadyPresent: true,
                clipName: clip.name,
                componentDisplayName: String(existing.displayName || ""),
                numParams: existing.properties ? existing.properties.numItems : 0 };
        }

        try { app.enableQE(); } catch (e) {}
        if (typeof qe === "undefined" || !qe.project) {
            return { ok: false, error: "QE_UNAVAILABLE",
                message: "qe.project unavailable - Lumetri Color requires QE DOM." };
        }
        var effect = null;
        try { effect = qe.project.getVideoEffectByName("Lumetri Color"); }
        catch (e) { return { ok: false, error: "QE_EFFECT_LOOKUP_FAILED",
            message: e.message || String(e) }; }
        if (!effect) return { ok: false, error: "EFFECT_NOT_FOUND",
            message: "Premiere did not return a 'Lumetri Color' effect from QE." };

        // Find the corresponding QE clip (matching trackIndex+clipIndex).
        var qeSeq = qe.project.getActiveSequence();
        var qeTrack = qeSeq.getVideoTrackAt(args.__resolved.trackIndex);
        var qeClip = qeTrack && qeTrack.getItemAt(args.__resolved.clipIndex);
        if (!qeClip) return { ok: false, error: "QE_CLIP_NOT_FOUND",
            message: "No QE clip at V" + (args.__resolved.trackIndex + 1)
                + " index " + args.__resolved.clipIndex };

        pbBeginUndo("PremBot: apply Lumetri Color to " + clip.name);
        try { qeClip.addVideoEffect(effect); }
        finally { pbEndUndo(); }

        // Verify by refetching the DOM component list.
        var after = pbHelperFindLumetriComponent(clip);
        if (!after) return { ok: false, error: "APPLY_DID_NOT_LAND",
            message: "addVideoEffect returned but no Lumetri component appeared." };
        return { ok: true, applied: true, clipName: clip.name,
            componentDisplayName: String(after.displayName || ""),
            numParams: after.properties ? after.properties.numItems : 0 };
    },

    list_lumetri_params: function (args) {
        var clip = pbHelperResolveClip(args);
        if (!clip) return { ok: false, error: "CLIP_NOT_FOUND",
            message: pbHelperResolveExplain(args) };
        var lumetri = pbHelperFindLumetriComponent(clip);
        if (!lumetri) return { ok: false, error: "LUMETRI_NOT_APPLIED",
            message: "No Lumetri Color component on " + clip.name
                + ". Call apply_lumetri first." };
        var params = [];
        if (lumetri.properties) {
            for (var i = 0; i < lumetri.properties.numItems; i++) {
                var p = lumetri.properties[i];
                var entry = { index: i, displayName: String(p.displayName || "") };
                try { entry.value = p.getValue(); } catch (e) {}
                try { entry.isTimeVarying = !!p.isTimeVarying(); } catch (e) {}
                params.push(entry);
            }
        }
        return { ok: true, clipName: clip.name, count: params.length,
            params: params };
    },

    set_lumetri_params: function (args) {
        var clip = pbHelperResolveClip(args);
        if (!clip) return { ok: false, error: "CLIP_NOT_FOUND",
            message: pbHelperResolveExplain(args) };
        var lumetri = pbHelperFindLumetriComponent(clip);
        if (!lumetri) return { ok: false, error: "LUMETRI_NOT_APPLIED",
            message: "No Lumetri Color component on " + clip.name
                + ". Call apply_lumetri first." };
        var params = args.params || {};
        var applied = [];
        var skipped = [];
        var label = "PremBot: grade " + clip.name;
        pbBeginUndo(label);
        try {
            for (var name in params) {
                if (!params.hasOwnProperty(name)) continue;
                var prop = pbHelperFindLumetriProperty(lumetri, name);
                if (!prop) {
                    skipped.push({ name: name, reason: "PROPERTY_NOT_FOUND" });
                    continue;
                }
                var rawVal = params[name];
                // Lumetri has a small set of string-valued properties
                // (Input LUT and Look on the Creative tab) that take a
                // LUT name or .cube file path. Everything else is numeric.
                var dnLower = String(prop.displayName || "").toLowerCase();
                var allowString = (dnLower === "input lut" || dnLower === "look");
                var sendVal;
                if (allowString && typeof rawVal === "string") {
                    sendVal = rawVal;
                } else {
                    var numVal = Number(rawVal);
                    if (!isFinite(numVal)) {
                        skipped.push({ name: name, reason: "VALUE_NOT_NUMERIC",
                            value: rawVal });
                        continue;
                    }
                    sendVal = numVal;
                }
                var before = null;
                try { before = prop.getValue(); } catch (e) {}
                try { prop.setTimeVarying(false); } catch (e) {}
                try {
                    prop.setValue(sendVal, true);
                    var after = null;
                    try { after = prop.getValue(); } catch (e) {}
                    applied.push({ name: name,
                        displayName: String(prop.displayName || name),
                        before: before, requested: sendVal, after: after });
                } catch (e) {
                    skipped.push({ name: name, reason: "SETVALUE_THREW",
                        message: e.message || String(e) });
                }
            }
        } finally { pbEndUndo(); }
        return { ok: true, clipName: clip.name,
            applied: applied, skipped: skipped,
            appliedCount: applied.length, skippedCount: skipped.length };
    },

    // Export the current playhead frame (or a frame at a specific second)
    // as a JPEG and return base64 + path. Used to feed Claude vision so
    // it can suggest grading parameters from the actual pixels.
    export_frame_b64: function (args) {
        var seq = app.project.activeSequence;
        if (!seq) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };

        var atSec = (typeof args.atSec === "number") ? args.atSec : null;
        if (atSec === null) {
            try { atSec = seq.getPlayerPosition().seconds; }
            catch (e) {
                return { ok: false, error: "NO_PLAYER_POSITION",
                    message: e.message || String(e) };
            }
        }
        var res = pbHelperExportFrameAt(seq, atSec);
        if (!res.ok) return res;
        res.clipAtPlayhead = pbHelperClipAtTime(seq, 0, atSec);
        return res;
    },

    // Export one frame per V1 clip (or a subset), sampled at the clip's
    // timeline midpoint by default. Returns an array of frame entries
    // the agent can hand to Claude vision in a single tool_result.
    export_frames_for_v1: function (args) {
        var seq = app.project.activeSequence;
        if (!seq) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };

        var track = seq.videoTracks[0];
        if (!track) return { ok: false, error: "NO_V1_TRACK" };

        // Optional filter: { currentStartSeconds: [..] } - if present,
        // only sample those clips; else every V1 clip.
        var wanted = null;
        if (args.currentStartSeconds && args.currentStartSeconds.length) {
            wanted = {};
            for (var i = 0; i < args.currentStartSeconds.length; i++) {
                wanted[String(args.currentStartSeconds[i])] = true;
            }
        }
        var maxFrames = (typeof args.maxFrames === "number"
            && args.maxFrames > 0) ? args.maxFrames : 12;

        var samplePoint = args.samplePoint === "start"
            ? "start" : "midpoint"; // "start" | "midpoint"

        var frames = [];
        var errors = [];
        for (var ci = 0; ci < track.clips.numItems && frames.length < maxFrames; ci++) {
            var clip = track.clips[ci];
            var startSec = 0, endSec = 0;
            try { startSec = clip.start.seconds; } catch (e) {}
            try { endSec   = clip.end.seconds;   } catch (e) {}
            if (wanted) {
                var keyA = String(startSec);
                if (!wanted[keyA]) continue;
            }
            // Pick a representative second inside the clip's timeline
            // range. Midpoint is the safest "what does this clip look
            // like" frame; start often catches a fade-in / black frame.
            var atSec;
            if (samplePoint === "start") {
                atSec = startSec + 0.05; // tiny offset past the cut
            } else {
                atSec = startSec + Math.max(0.1, (endSec - startSec) / 2);
            }
            var r = pbHelperExportFrameAt(seq, atSec);
            if (!r.ok) {
                errors.push({ clipIndex: ci, clipName: clip.name,
                    atSec: atSec, error: r.error, message: r.message });
                continue;
            }
            frames.push({
                clipIndex: ci,
                clipName: clip.name,
                currentStartSeconds: startSec,
                endSeconds: endSec,
                atSec: atSec,
                mediaType: r.mediaType,
                base64: r.base64,
                byteLength: r.byteLength,
                path: r.path
            });
        }
        return { ok: true, count: frames.length,
            errorCount: errors.length, errors: errors, frames: frames };
    },

    // Apply a Premiere effect preset (.prfpset) - the canonical way to
    // ship a Lumetri Look or any other parameterized effect bundle.
    // This wraps the existing PremBot.applyClipPreset top-level so the
    // helper bridge can reach it.
    apply_clip_preset: function (args) {
        var clip = pbHelperResolveClip(args);
        if (!clip) return { ok: false, error: "CLIP_NOT_FOUND",
            message: pbHelperResolveExplain(args) };
        if (!args.presetPath) return { ok: false, error: "MISSING_PRESET_PATH" };
        var f = new File(String(args.presetPath));
        if (!f.exists) return { ok: false, error: "PRESET_FILE_NOT_FOUND",
            presetPath: args.presetPath };
        if (typeof clip.applyPreset !== "function") {
            return { ok: false, error: "APPLY_PRESET_UNSUPPORTED",
                message: "applyPreset is not a function on this clip "
                    + "(Premiere version too old, or item type wrong)." };
        }
        pbBeginUndo("PremBot: apply preset " + args.presetPath);
        var rc;
        try { rc = clip.applyPreset(f); }
        finally { pbEndUndo(); }
        return { ok: !!rc, clipName: clip.name,
            presetPath: String(args.presetPath), result: !!rc };
    },

    // add_marker: drop a marker on the active sequence (or on a specific
    // trackItem if kind+trackIndex+clipIndex provided).
    // args: { atSec, label, markerType?, comments?, durationSec?,
    //         kind?, trackIndex?, clipIndex? }
    add_marker: function (args) {
        var target;
        var scope;
        if (typeof args.trackIndex === "number"
            && typeof args.clipIndex === "number") {
            target = pbHelperGetClip(args.kind || "video",
                args.trackIndex, args.clipIndex);
            scope = "clip";
        } else {
            target = app.project.activeSequence;
            if (!target) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };
            scope = "sequence";
        }
        var atSec = args.atSec || 0;
        var result;
        pbBeginUndo("PremBot: add marker"
            + (args.label ? " \"" + args.label + "\"" : "")
            + " at " + atSec + "s");
        try {
            var marker = target.markers.createMarker(atSec);
            if (args.label) marker.name = args.label;
            if (args.comments) marker.comments = args.comments;
            if (args.markerType) {
                try {
                    if (args.markerType === "Comment"      && marker.setTypeAsComment)      marker.setTypeAsComment();
                    else if (args.markerType === "Chapter" && marker.setTypeAsChapter)      marker.setTypeAsChapter();
                    else if (args.markerType === "WebLink" && marker.setTypeAsWebLink)      marker.setTypeAsWebLink();
                    else if (args.markerType === "Segmentation" && marker.setTypeAsSegmentation) marker.setTypeAsSegmentation();
                } catch (e) {}
            }
            if (typeof args.durationSec === "number" && args.durationSec > 0) {
                try { marker.end = pbHelperTime(atSec + args.durationSec); }
                catch (e) {}
            }
            result = { ok: true, scope: scope, atSec: atSec,
                label: args.label || null };
        } finally {
            pbEndUndo();
        }
        return result;
    }
};

// ---- Helpers used by pbHelperHandlers ----

function pbHelperTime(seconds) {
    var t = new Time();
    t.seconds = seconds;
    return t;
}

// app.beginUndoGroup / endUndoGroup are documented as the ExtendScript
// transaction pattern in some Adobe apps (After Effects, Bridge), but
// Premiere's ExtendScript runtime doesn't expose them - calling them
// throws "is not a function". Wrap each call so handlers don't break
// if the function is missing; the mutation still lands on Premiere's
// undo stack as its own entry, just without our descriptive label.
function pbBeginUndo(label) {
    if (typeof app !== "undefined" && typeof app.beginUndoGroup === "function") {
        try { app.beginUndoGroup(label || "PremBot edit"); } catch (e) {}
    }
}
function pbEndUndo() {
    if (typeof app !== "undefined" && typeof app.endUndoGroup === "function") {
        try { app.endUndoGroup(); } catch (e) {}
    }
}

function pbHelperTicksFromSec(seconds) {
    // QE razor takes ticks. 254016000000 ticks per second.
    return String(Math.round(seconds * 254016000000));
}

function pbHelperGetClip(kind, trackIndex, clipIndex) {
    var seq = app.project.activeSequence;
    if (!seq) throw new Error("No active sequence");
    var tracks = (kind === "audio") ? seq.audioTracks : seq.videoTracks;
    var track = tracks[trackIndex];
    if (!track) throw new Error("No " + (kind || "video")
        + " track at index " + trackIndex);
    var clip = track.clips[clipIndex];
    if (!clip) throw new Error("No clip at index " + clipIndex
        + " on " + (kind === "audio" ? "A" : "V") + (trackIndex + 1));
    return clip;
}

function pbHelperReadClipTimes(clip) {
    var read = function (t) {
        try { return t && typeof t.seconds === "number" ? t.seconds : null; }
        catch (e) { return null; }
    };
    return {
        start:    read(clip.start),
        end:      read(clip.end),
        inPoint:  read(clip.inPoint),
        outPoint: read(clip.outPoint)
    };
}

// Resolve a clip from {kind, trackIndex, clipIndex} OR {trackIndex,
// currentStartSeconds}. On success, mutates args.__resolved to expose
// the indices the caller actually used (handlers that need to reach
// QE separately, like apply_lumetri, rely on this).
function pbHelperResolveClip(args) {
    var kind = (args.kind === "audio") ? "audio" : "video";
    var ti = (typeof args.trackIndex === "number") ? args.trackIndex : 0;
    var seq = app.project.activeSequence;
    if (!seq) throw new Error("No active sequence");
    var tracks = (kind === "audio") ? seq.audioTracks : seq.videoTracks;
    var track = tracks[ti];
    if (!track) return null;

    if (typeof args.clipIndex === "number") {
        var c = track.clips[args.clipIndex];
        if (!c) return null;
        args.__resolved = { kind: kind, trackIndex: ti,
            clipIndex: args.clipIndex };
        return c;
    }
    if (typeof args.currentStartSeconds === "number") {
        var tol = 0.05;
        for (var i = 0; i < track.clips.numItems; i++) {
            var c2 = track.clips[i];
            var sSec = 0;
            try { sSec = c2.start.seconds; } catch (e) {}
            if (Math.abs(sSec - args.currentStartSeconds) < tol) {
                args.__resolved = { kind: kind, trackIndex: ti,
                    clipIndex: i };
                return c2;
            }
        }
        return null;
    }
    return null;
}

function pbHelperResolveExplain(args) {
    if (typeof args.clipIndex === "number") {
        return "No clip at index " + args.clipIndex
            + " on " + ((args.kind === "audio") ? "A" : "V")
            + ((args.trackIndex || 0) + 1);
    }
    return "No clip on V" + ((args.trackIndex || 0) + 1)
        + " at start=" + args.currentStartSeconds + "s";
}

function pbHelperFindLumetriComponent(clip) {
    if (!clip.components) return null;
    for (var i = 0; i < clip.components.numItems; i++) {
        var c = clip.components[i];
        var dn = String(c.displayName || "").toLowerCase();
        var mn = String(c.matchName   || "").toLowerCase();
        if (dn === "lumetri color" || mn.indexOf("lumetri") >= 0) return c;
    }
    return null;
}

// Lumetri Color exposes its parameters as a flat properties[] list on
// the component. Names map to the labels shown in the Lumetri Color
// effect panel (e.g. "Temperature", "Tint", "Exposure", "Contrast",
// "Highlights", "Shadows", "Whites", "Blacks", "Saturation",
// "Vibrance"). Match case-insensitively and also accept aliases.
function pbHelperFindLumetriProperty(component, requested) {
    if (!component || !component.properties) return null;
    var want = String(requested).toLowerCase();
    var aliases = pbHelperLumetriAliases[want] || [want];
    for (var i = 0; i < component.properties.numItems; i++) {
        var p = component.properties[i];
        var dn = String(p.displayName || "").toLowerCase();
        for (var j = 0; j < aliases.length; j++) {
            if (dn === aliases[j]) return p;
        }
    }
    return null;
}

// Common short names → Lumetri Color's actual displayName values.
// Lumetri uses spaces and capitalization that matches the panel labels.
var pbHelperLumetriAliases = {
    "temperature": ["temperature"],
    "temp":        ["temperature"],
    "tint":        ["tint"],
    "exposure":    ["exposure"],
    "contrast":    ["contrast"],
    "highlights":  ["highlights"],
    "shadows":     ["shadows"],
    "whites":      ["whites"],
    "blacks":      ["blacks"],
    "saturation":  ["saturation"],
    "vibrance":    ["vibrance"],
    "sharpen":     ["sharpen"],
    "faded film":  ["faded film"],
    "faded_film":  ["faded film"],
    "intensity":   ["intensity"],
    "vignette amount":    ["amount"],
    "vignette_amount":    ["amount"],
    "vignette midpoint":  ["midpoint"],
    "vignette feather":   ["feather"],
    "vignette roundness": ["roundness"],
    // String-valued LUT slots. "lut" is ambiguous in the panel - we
    // default it to the Creative Look slot since that's the stylistic
    // one; technical (Input LUT) callers should spell it out.
    "look":      ["look"],
    "lut":       ["look", "input lut"],
    "input lut": ["input lut"],
    "input_lut": ["input lut"]
};

// Export one frame to disk + return base64. Shared by export_frame_b64
// (single) and export_frames_for_v1 (multi). Generates a unique temp
// filename per call so concurrent frames don't collide.
var pbHelperFrameCounter = 0;
function pbHelperExportFrameAt(seq, atSec) {
    var tmpDir = Folder.temp.fsName;
    var sep = (String(tmpDir).indexOf("\\") >= 0) ? "\\" : "/";
    pbHelperFrameCounter++;
    var name = "prembot-frame-" + (new Date().getTime())
        + "-" + pbHelperFrameCounter + ".jpg";
    var outPath = tmpDir + sep + name;
    var tickStr = String(Math.round(atSec * 254016000000));

    var exportFn = seq.exportFrameJPEG || seq.exportFramePNG;
    if (!exportFn) return { ok: false, error: "NO_EXPORT_FRAME_API",
        message: "Sequence.exportFrameJPEG / exportFramePNG unavailable." };
    var mediaType = seq.exportFrameJPEG ? "image/jpeg" : "image/png";
    try { exportFn.call(seq, tickStr, outPath); }
    catch (e) { return { ok: false, error: "EXPORT_FRAME_THREW",
        message: e.message || String(e), atSec: atSec }; }

    var f = new File(outPath);
    f.encoding = "BINARY";
    if (!f.exists) return { ok: false, error: "EXPORT_FRAME_NOFILE",
        message: "Premiere did not write " + outPath, atSec: atSec };
    f.open("r");
    var bin = f.read();
    f.close();
    var b64 = pbHelperBase64(bin);
    return { ok: true, path: outPath, mediaType: mediaType,
        atSec: atSec, tickStr: tickStr, base64: b64,
        byteLength: bin.length };
}

// Return the V<trackIndex+1> clip that contains a given timeline
// second, or null if the time falls in a gap. Caller uses this to
// annotate frame exports with the clip they belong to.
function pbHelperClipAtTime(seq, trackIndex, atSec) {
    var track = seq.videoTracks[trackIndex || 0];
    if (!track) return null;
    for (var ci = 0; ci < track.clips.numItems; ci++) {
        var clip = track.clips[ci];
        var s = 0, e = 0;
        try { s = clip.start.seconds; } catch (ex) {}
        try { e = clip.end.seconds;   } catch (ex) {}
        if (atSec >= s - 0.001 && atSec < e + 0.001) {
            return { clipIndex: ci, clipName: clip.name,
                startSec: s, endSec: e,
                timeIntoClipSec: atSec - s,
                durationSec: e - s };
        }
    }
    return null;
}

// Base64-encode a binary string (ExtendScript File.read returns a
// string of one-byte chars when encoding = "BINARY").
var pbBase64Alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function pbHelperBase64(bin) {
    var out = [];
    var i = 0;
    var len = bin.length;
    while (i < len) {
        var c1 = bin.charCodeAt(i++) & 0xff;
        var c2 = (i < len) ? bin.charCodeAt(i++) & 0xff : NaN;
        var c3 = (i < len) ? bin.charCodeAt(i++) & 0xff : NaN;
        var e1 = c1 >> 2;
        var e2 = ((c1 & 0x3) << 4) | (isNaN(c2) ? 0 : (c2 >> 4));
        var e3 = isNaN(c2) ? 64 : (((c2 & 0xf) << 2) | (isNaN(c3) ? 0 : (c3 >> 6)));
        var e4 = isNaN(c3) ? 64 : (c3 & 0x3f);
        out.push(pbBase64Alphabet.charAt(e1));
        out.push(pbBase64Alphabet.charAt(e2));
        out.push(e3 === 64 ? "=" : pbBase64Alphabet.charAt(e3));
        out.push(e4 === 64 ? "=" : pbBase64Alphabet.charAt(e4));
    }
    return out.join("");
}

function pbHelperFindProjectItem(name) {
    // Walk the project root recursively looking for an item with that name.
    function walk(folder) {
        if (!folder || !folder.children) return null;
        for (var i = 0; i < folder.children.numItems; i++) {
            var it = folder.children[i];
            if (!it) continue;
            if (it.name === name) return it;
            if (it.type === ProjectItemType.BIN) {
                var hit = walk(it);
                if (hit) return hit;
            }
        }
        return null;
    }
    return walk(app.project.rootItem);
}
