// PremBot ExtendScript host — bridges the panel to Premiere via QE / DOM scripting.
#target premierepro

// Load the JSON polyfill explicitly; //@include is unreliable under CEP's ScriptPath loader.
(function () {
    try {
        var hostDir = (new File($.fileName)).parent.fsName;
        $.evalFile(hostDir + '/json2.js');
    } catch (e) {}
})();

var PremBot = (function () {
    function ok(data)   { return JSON.stringify({ ok: true,  data: data }); }
    function err(msg)   { return JSON.stringify({ ok: false, error: String(msg) }); }
    function _safe(fn)  { try { return fn(); } catch (e) { return err(e.message || e); } }

    // Walk the project tree, collecting clip-type items (type 1 == CLIP).
    function _walkClips(rootItem, out) {
        for (var i = 0; i < rootItem.children.numItems; i++) {
            var child = rootItem.children[i];
            if (child.type === 2) {                  // 2 = BIN
                _walkClips(child, out);
            } else if (child.type === 1 && typeof child.getMediaPath === 'function') {
                var path = '';
                try { path = child.getMediaPath() || ''; } catch (e) {}
                if (path) {
                    out.push({
                        nodeId:   child.nodeId,
                        name:     child.name,
                        path:     path,
                        duration: (child.getOutPoint && child.getInPoint)
                                    ? null  // computed below if possible
                                    : null
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

        clearActiveSequence: function () {
            return _safe(function () {
                var seq = app.project.activeSequence;
                if (!seq) return err('No active sequence');
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

        // Insert a portion of a project clip onto the active sequence.
        // nodeId             — project item id from listProjectClips()
        // sourceIn / sourceOut — seconds within the source media
        // timelineStart       — seconds on the active sequence
        // track               — 0-based video track index (audio mirrors)
        addSegment: function (nodeId, sourceIn, sourceOut, timelineStart, track) {
            return _safe(function () {
                var seq = app.project.activeSequence;
                if (!seq) return err('No active sequence — create one in Premiere first.');
                var item = _findByNodeId(app.project.rootItem, nodeId);
                if (!item) return err('Clip not found for nodeId ' + nodeId);

                // Set in/out on the project item; mediaType 4 = ANY.
                try { item.setInPoint(Number(sourceIn),  4); } catch (e) {}
                try { item.setOutPoint(Number(sourceOut), 4); } catch (e) {}

                var t = new Time();
                t.seconds = Number(timelineStart);

                var trackIndex = Number(track || 0);
                if (trackIndex >= seq.videoTracks.numTracks) return err('Video track out of range');

                seq.videoTracks[trackIndex].insertClip(item, t);
                return ok({ name: item.name, at: Number(timelineStart) });
            });
        }
    };
})();

// CSInterface evalScript can only call top-level functions, so expose them here.
function pbPing()                                           { return PremBot.ping(); }
function pbListProjectClips()                               { return PremBot.listProjectClips(); }
function pbGetActiveSequenceInfo()                          { return PremBot.getActiveSequenceInfo(); }
function pbClearActiveSequence()                            { return PremBot.clearActiveSequence(); }
function pbAddSegment(nodeId, sIn, sOut, tStart, track)     { return PremBot.addSegment(nodeId, sIn, sOut, tStart, track); }
