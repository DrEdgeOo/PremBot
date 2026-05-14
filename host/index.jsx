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
        app.beginUndoGroup("PremBot: trim " + (args.kind || "video")
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
            app.endUndoGroup();
        }
        return result;
    },

    // split_clip: razor-cut a clip at a timeline second via the QE API.
    // ExtendScript's QE namespace exposes razor at the sequence level.
    // args: { atSec }
    split_clip: function (args) {
        try { app.enableQE(); } catch (e) {}
        if (typeof qe === "undefined" || !qe.project) {
            return { ok: false, error: "QE_UNAVAILABLE",
                message: "qe.project is not available even after enableQE()." };
        }
        var seq = qe.project.getActiveSequence();
        if (!seq) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };
        var result;
        app.beginUndoGroup("PremBot: split at " + args.atSec + "s");
        try {
            seq.razor(pbHelperTicksFromSec(args.atSec));
            result = { ok: true, atSec: args.atSec };
        } finally {
            app.endUndoGroup();
        }
        return result;
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
        app.beginUndoGroup("PremBot: insert " + args.projectItemName
            + " at " + (args.atSec || 0) + "s");
        try {
            track.insertClip(projItem, t);
            result = { ok: true, projectItemName: args.projectItemName,
                atSec: args.atSec, trackIndex: args.trackIndex };
        } finally {
            app.endUndoGroup();
        }
        return result;
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
        app.beginUndoGroup("PremBot: add marker"
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
            app.endUndoGroup();
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
