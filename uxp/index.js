// PremBot UXP entry.
//
// Uses the canonical premierepro DOM API:
//   - cross-boundary fetches are async (getActiveProject, getRootItem,
//     getTrackItems, TickTime.createWithSeconds, ...)
//   - mutations are wrapped in project.lockedAccess(() =>
//       project.executeTransaction((c) => c.addAction(action), "label"))
//
// Primitives confirmed working on Premiere 26.2.2:
//   - clip.createMoveAction(TickTime)             → move clip start to T
//   - clip.createSetDisabledAction(bool)          → toggle disabled
//   - editor.createRemoveItemsAction(sel, false, null)
//                                                 → delete clips from timeline
//   - editor.createCloneTrackItemAction(trackItem, offset, 0, 0, true, true)
//                                                 → clone an existing on-timeline
//                                                   clip with an offset (our
//                                                   "insert" primitive)
//   - projectItem.createSetNameAction(string)     → rename source bin item
//
// Known broken in 26.2.2 (factory exists, dispatch throws
// "Script action failed to execute"):
//   - clip.createSet[End|OutPoint|Start|InPoint]Action — trim primitives
//   - clip.createSetNameAction — trackItem rename
//   - editor.createInsertProjectItemAction          — insert from bin
//   - editor.createOverwriteItemAction              — overwrite

const { entrypoints } = require("uxp");
const ppro = require("premierepro");

// ---- Context ----

async function getContext() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("No project open");
    const sequence = await project.getActiveSequence();
    const editor = sequence
        ? await ppro.SequenceEditor.getEditor(sequence) : null;
    return { project, sequence, editor };
}

async function dispatch(project, action, label) {
    project.lockedAccess(() => {
        project.executeTransaction((c) => c.addAction(action), label);
    });
}

// ---- Reads ----

async function ping() {
    const { project, sequence } = await getContext();
    let seqInfo = null;
    if (sequence) {
        seqInfo = {
            name: sequence.name,
            videoTracks: await sequence.getVideoTrackCount(),
            audioTracks: await sequence.getAudioTrackCount()
        };
    }
    return {
        project: { name: project.name, path: project.path },
        activeSequence: seqInfo
    };
}

async function walkProjectItems(parent, out) {
    const items = await parent.getItems();
    for (const item of items) {
        const isFolder = (ppro.FolderItem && item instanceof ppro.FolderItem)
            || typeof item.getItems === "function";
        const isClip = (ppro.ClipProjectItem
            && item instanceof ppro.ClipProjectItem);
        if (isFolder && !isClip) {
            await walkProjectItems(item, out);
        } else {
            // Try every documented + observed shape for "where is this
            // clip's source media on disk?" - the API surface drifts
            // between UXP versions and we want the .wav lookup to work
            // regardless of which one this build exposes.
            let mediaPath = null;
            const tryGetters = [
                "getMediaFilePath", "getMediaPath",
                "getPath", "getFilePath"
            ];
            for (const g of tryGetters) {
                if (typeof item[g] === "function") {
                    try {
                        const r = await item[g]();
                        if (r && typeof r === "string") { mediaPath = r; break; }
                    } catch (e) {}
                }
            }
            out.push({ name: item.name, mediaPath });
        }
    }
}

async function listProjectClips() {
    const { project } = await getContext();
    const root = await project.getRootItem();
    const clips = [];
    await walkProjectItems(root, clips);
    return clips;
}

async function listSequenceClips() {
    const { sequence } = await getContext();
    if (!sequence) return { video: [], audio: [] };
    const out = { video: [], audio: [] };
    const vCount = await sequence.getVideoTrackCount();
    const aCount = await sequence.getAudioTrackCount();
    async function dump(getTrack, count, kind) {
        for (let ti = 0; ti < count; ti++) {
            const track = await getTrack.call(sequence, ti);
            const items = await track.getTrackItems(1, false);
            for (let ci = 0; ci < items.length; ci++) {
                const clip = items[ci];
                const sT = await clip.getStartTime().catch(() => null);
                const eT = await clip.getEndTime().catch(() => null);
                const iT = await clip.getInPoint().catch(() => null);
                const oT = await clip.getOutPoint().catch(() => null);
                const name = await clip.getName().catch(() => null);
                out[kind].push({
                    trackIndex: ti, clipIndex: ci, name,
                    startSeconds: sT && sT.seconds,
                    endSeconds:   eT && eT.seconds,
                    inSeconds:    iT && iT.seconds,
                    outSeconds:   oT && oT.seconds
                });
            }
        }
    }
    await dump(sequence.getVideoTrack, vCount, "video");
    await dump(sequence.getAudioTrack, aCount, "audio");
    return out;
}

// ---- Primitives: stable mutations ----
//
// All addressing is by trackIndex + currentStartSeconds (the clip's
// CURRENT timeline start, in seconds). This is stable across moves -
// unlike clipIndex, which sorts by start and reshuffles after each
// mutation. Match tolerance is half a frame at 24 fps (~0.02s).

const ADDR_TOLERANCE_SEC = 0.05;

async function findVideoClipByStart(sequence, trackIndex, currentStartSeconds) {
    const track = await sequence.getVideoTrack(trackIndex);
    const items = await track.getTrackItems(1, false);
    for (const item of items) {
        const s = await item.getStartTime();
        if (s && typeof s.seconds === "number"
            && Math.abs(s.seconds - currentStartSeconds) < ADDR_TOLERANCE_SEC) {
            return { clip: item, track };
        }
    }
    throw new Error("No clip on V" + (trackIndex + 1)
        + " at start=" + currentStartSeconds + "s");
}

// Find an audio clip on A<trackIndex+1> whose name and start match a
// given video clip - the standard signature of a linked A/V pair from
// one .mp4 source. Returns null if no partner exists (silent video).
async function findAudioPartner(sequence, trackIndex, videoName, videoStartSec) {
    const aTrack = await sequence.getAudioTrack(trackIndex);
    if (!aTrack) return null;
    const items = await aTrack.getTrackItems(1, false);
    for (const item of items) {
        const s = await item.getStartTime();
        const n = await item.getName().catch(() => null);
        if (!s || !n) continue;
        if (n === videoName
            && Math.abs(s.seconds - videoStartSec) < ADDR_TOLERANCE_SEC) {
            return item;
        }
    }
    return null;
}

// In this Premiere build, clip.createMoveAction(t) is a RELATIVE
// shift: it adds t seconds to the clip's current start. It is also
// forward-only - TickTime.createWithSeconds rejects negative values.
// So moveClipsBatch can only shift clips later in time. Backward
// shifts have to be reported as unsupported and the model should be
// told to plan around the constraint.

async function moveClipsBatch(trackIndex, moves) {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");

    const backward = moves.filter(
        (m) => (m.newStartSeconds - m.currentStartSeconds) < -ADDR_TOLERANCE_SEC);
    if (backward.length > 0) {
        return {
            ok: false,
            error: "BACKWARD_MOVE_UNSUPPORTED",
            message: "move_clips can only shift clips FORWARD in time on this "
                + "Premiere build. " + backward.length + " of " + moves.length
                + " requested move(s) need a backward shift, which the UXP "
                + "createMoveAction does not support. Re-plan with only "
                + "forward shifts, or tell the user the goal is not achievable "
                + "with the available primitives.",
            backwardMoves: backward,
            trackIndex
        };
    }

    // Resolve clips and build relative-delta actions in one pass.
    // For each video move, also move the audio partner under it (same
    // name + start) by the same delta so A/V stays in sync.
    const resolved = [];
    let pairedAudio = 0;
    for (const m of moves) {
        const { clip } = await findVideoClipByStart(sequence, trackIndex,
            m.currentStartSeconds);
        const deltaSec = m.newStartSeconds - m.currentStartSeconds;
        const delta = await ppro.TickTime.createWithSeconds(deltaSec);
        const action = await clip.createMoveAction(delta);
        const name = await clip.getName().catch(() => null);
        const partner = name
            ? await findAudioPartner(sequence, trackIndex, name,
                m.currentStartSeconds)
            : null;
        const audioAction = partner
            ? await partner.createMoveAction(delta) : null;
        if (audioAction) pairedAudio++;
        resolved.push({ action, audioAction, m, deltaSec });
    }

    project.lockedAccess(() => {
        project.executeTransaction((c) => {
            for (const r of resolved) c.addAction(r.action);
            for (const r of resolved) if (r.audioAction) c.addAction(r.audioAction);
        }, "PremBot: move " + resolved.length + " clip(s) on V"
            + (trackIndex + 1));
    });

    // Verify post-state: every requested target must appear as an
    // actual clip start on the track.
    const track = await sequence.getVideoTrack(trackIndex);
    const after = await track.getTrackItems(1, false);
    const afterStarts = [];
    for (const it of after) {
        const s = await it.getStartTime();
        if (s && typeof s.seconds === "number") afterStarts.push(s.seconds);
    }
    const expected = moves.map((m) => m.newStartSeconds).sort((a, b) => a - b);
    const actual = afterStarts.slice().sort((a, b) => a - b);
    const matches = expected.length === actual.length
        && expected.every((v, i) => Math.abs(v - actual[i]) < ADDR_TOLERANCE_SEC);

    return {
        ok: matches, trackIndex, count: resolved.length,
        pairedAudioClips: pairedAudio,
        moves: resolved.map((r) => ({ ...r.m, deltaSec: r.deltaSec })),
        expectedStartsSorted: expected,
        actualStartsSorted: actual,
        warning: matches ? undefined
            : "Some clips did not land where requested. Use "
              + "list_timeline_clips and re-plan."
    };
}

async function moveClip(trackIndex, currentStartSeconds, newStartSeconds) {
    return moveClipsBatch(trackIndex,
        [{ currentStartSeconds, newStartSeconds }]);
}

async function setClipDisabled(trackIndex, currentStartSeconds, disabled) {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const { clip } = await findVideoClipByStart(sequence, trackIndex,
        currentStartSeconds);
    const action = await clip.createSetDisabledAction(!!disabled);
    await dispatch(project, action,
        "PremBot: " + (disabled ? "disable" : "enable")
        + " V" + (trackIndex + 1) + " clip at " + currentStartSeconds + "s");
    return { ok: true, trackIndex, currentStartSeconds, disabled: !!disabled };
}

async function cloneClipToTime(srcTrackIndex, srcCurrentStartSeconds, targetStartSeconds) {
    const { project, sequence, editor } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    if (!editor)   throw new Error("Could not get SequenceEditor");
    const { clip: src } = await findVideoClipByStart(sequence,
        srcTrackIndex, srcCurrentStartSeconds);
    const offsetSec = targetStartSeconds - srcCurrentStartSeconds;
    if (offsetSec < -ADDR_TOLERANCE_SEC) {
        return {
            ok: false,
            error: "BACKWARD_CLONE_UNSUPPORTED",
            message: "clone_clip_to_time only supports a target that is at "
                + "or after the source clip's current start. Pick a target "
                + "time >= the source's start, or choose a source that is "
                + "earlier in the timeline.",
            srcCurrentStartSeconds, targetStartSeconds
        };
    }
    const offset = await ppro.TickTime.createWithSeconds(offsetSec);
    const vAction = await editor.createCloneTrackItemAction(
        src, offset, /* vVertOff */ 0, /* aVertOff */ 0,
        /* alignToVideo */ true, /* isInsert */ true);

    // Clone the audio partner with the same delta so it lands under
    // the cloned video.
    const name = await src.getName().catch(() => null);
    const partner = name
        ? await findAudioPartner(sequence, srcTrackIndex, name,
            srcCurrentStartSeconds)
        : null;
    const aAction = partner
        ? await editor.createCloneTrackItemAction(
            partner, offset, 0, 0, true, true)
        : null;

    project.lockedAccess(() => {
        project.executeTransaction((c) => {
            c.addAction(vAction);
            if (aAction) c.addAction(aAction);
        }, "PremBot: clone V" + (srcTrackIndex + 1) + " clip at "
            + srcCurrentStartSeconds + "s to " + targetStartSeconds + "s");
    });

    return { ok: true, srcTrackIndex, srcCurrentStartSeconds,
        targetStartSeconds, offsetSec, audioCloned: !!aAction };
}

async function removeClips(trackIndex, currentStartSecondsList, ripple) {
    const { project, sequence, editor } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    if (!editor)   throw new Error("Could not get SequenceEditor");

    // Resolve each requested video clip AND its audio partner. The
    // partner (same name + start on A<trackIndex+1>) goes into the
    // same selection so a single remove action pulls A/V together.
    const videoTargets = [];
    const audioTargets = [];
    for (const s of currentStartSecondsList) {
        const { clip } = await findVideoClipByStart(sequence, trackIndex, s);
        videoTargets.push(clip);
        const name = await clip.getName().catch(() => null);
        const partner = name
            ? await findAudioPartner(sequence, trackIndex, name, s) : null;
        if (partner) audioTargets.push(partner);
    }
    if (videoTargets.length === 0) {
        return { ok: true, removed: 0, removedAudioClips: 0,
            note: "No matching clips" };
    }
    const sel = await sequence.getSelection();
    if (typeof sequence.clearSelection === "function") {
        try { await sequence.clearSelection(); } catch (e) {}
    }
    for (const it of videoTargets) {
        try { await sel.addItem(it); } catch (e) {}
    }
    for (const it of audioTargets) {
        try { await sel.addItem(it); } catch (e) {}
    }
    const action = await editor.createRemoveItemsAction(sel, !!ripple, null);
    await dispatch(project, action,
        "PremBot: " + (ripple ? "ripple-remove " : "remove ")
        + videoTargets.length + " clip(s) from V" + (trackIndex + 1));
    return {
        ok: true,
        removed: videoTargets.length,
        removedAudioClips: audioTargets.length,
        ripple: !!ripple,
        trackIndex, currentStartSecondsList
    };
}

async function clearV1() {
    const { sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);
    if (items.length === 0) return { ok: true, cleared: 0 };
    const starts = [];
    for (const it of items) {
        const s = await it.getStartTime();
        if (s && typeof s.seconds === "number") starts.push(s.seconds);
    }
    return removeClips(0, starts);
}

// Reorder a video track into a new clip ordering.
//
// `newOrder` is an array of clip-identifying current start times, in the
// desired final visual order. e.g. for [35, 30, 22, 18, 12, 8, 3, 0] the
// clip currently at 35s should appear first, then the clip at 30s, etc.
//
// Strategy: clone each clip into a staging zone past existing content
// in the desired layout, then ripple-remove all originals. Clones slide
// back into the freed space. Premiere's ripple amount can be smaller
// than the total removed duration (e.g. when linked audio holds clips
// in place), so the final layout may be uniformly offset from absolute
// 0. We report this in the result rather than trying to chase it - the
// caller (or the user) can drag the block left manually if desired.

async function reorderTrack(trackIndex, newOrder) {
    const { project, sequence, editor } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    if (!editor)   throw new Error("Could not get SequenceEditor");

    const vTrack = await sequence.getVideoTrack(trackIndex);
    const vItems = await vTrack.getTrackItems(1, false);
    if (vItems.length === 0) {
        return { ok: false, error: "Track V" + (trackIndex + 1) + " is empty" };
    }

    // Read A1 audio so we can sync any partnered audio clips with the
    // same name and start. (Most V/A pairs from one source share both.)
    const aTrack = await sequence.getAudioTrack(trackIndex);
    const aItems = aTrack ? await aTrack.getTrackItems(1, false) : [];
    const audioByKey = new Map();
    let maxAEndSec = 0;
    for (const a of aItems) {
        const s = await a.getStartTime();
        const e = await a.getEndTime();
        const n = await a.getName().catch(() => null);
        if (!s || !e || !n) continue;
        const key = n + "@" + Math.round(s.seconds * 1000) / 1000;
        audioByKey.set(key, { clip: a, startSec: s.seconds });
        if (e.seconds > maxAEndSec) maxAEndSec = e.seconds;
    }

    // Build V1 map by start time.
    const byStart = new Map();
    let maxVEndSec = 0;
    for (const it of vItems) {
        const s = await it.getStartTime();
        const e = await it.getEndTime();
        const name = await it.getName().catch(() => null);
        if (!s || !e) continue;
        byStart.set(Math.round(s.seconds * 1000) / 1000, {
            clip: it, startSec: s.seconds, endSec: e.seconds,
            durationSec: e.seconds - s.seconds, name
        });
        if (e.seconds > maxVEndSec) maxVEndSec = e.seconds;
    }

    const resolved = [];
    for (const cs of newOrder) {
        const key = Math.round(cs * 1000) / 1000;
        let entry = byStart.get(key);
        if (!entry) {
            for (const [k, v] of byStart) {
                if (Math.abs(k - cs) < ADDR_TOLERANCE_SEC) { entry = v; break; }
            }
        }
        if (!entry) {
            return { ok: false, error: "No clip on V" + (trackIndex + 1)
                + " at start=" + cs + "s" };
        }
        // Attach the audio partner if there is one with matching name + start.
        const partnerKey = entry.name + "@"
            + (Math.round(entry.startSec * 1000) / 1000);
        const partner = audioByKey.get(partnerKey);
        entry.audioClip = partner ? partner.clip : null;
        resolved.push(entry);
    }

    // Desired final layout (packed from 0).
    const desired = [];
    let cursor = 0;
    for (const r of resolved) {
        desired.push({ ...r, desiredStartSec: cursor });
        cursor += r.durationSec;
    }
    const totalDuration = cursor;

    // Stage past both V and A content so neither track's clones collide.
    const stageOffsetSec = Math.max(maxVEndSec, maxAEndSec) + 1;

    const cloneActions = [];
    let pairedAudio = 0;
    for (const d of desired) {
        const cloneTargetSec = d.desiredStartSec + stageOffsetSec;
        const vOffsetSec = cloneTargetSec - d.startSec;
        const vOffset = await ppro.TickTime.createWithSeconds(vOffsetSec);
        cloneActions.push(await editor.createCloneTrackItemAction(
            d.clip, vOffset, 0, 0, true, true));
        if (d.audioClip) {
            // Same source-to-target delta on the audio partner so it
            // stays under the video clone.
            const aStart = (await d.audioClip.getStartTime()).seconds;
            const aOffsetSec = cloneTargetSec - aStart;
            const aOffset = await ppro.TickTime.createWithSeconds(aOffsetSec);
            cloneActions.push(await editor.createCloneTrackItemAction(
                d.audioClip, aOffset, 0, 0, true, true));
            pairedAudio++;
        }
    }

    // Ripple-remove every original V clip on this track AND every
    // partnered A clip, so audio lines back up under the video clones.
    const sel = await sequence.getSelection();
    if (typeof sequence.clearSelection === "function") {
        try { await sequence.clearSelection(); } catch (e) {}
    }
    for (const it of vItems) {
        try { await sel.addItem(it); } catch (e) {}
    }
    for (const r of resolved) {
        if (r.audioClip) {
            try { await sel.addItem(r.audioClip); } catch (e) {}
        }
    }
    const rippleAction = await editor.createRemoveItemsAction(sel, true, null);

    project.lockedAccess(() => {
        project.executeTransaction((c) => {
            for (const a of cloneActions) c.addAction(a);
            c.addAction(rippleAction);
        }, "PremBot: reorder V" + (trackIndex + 1));
    });

    // Read back what actually landed.
    const trackAfter = await sequence.getVideoTrack(trackIndex);
    const itemsAfter = await trackAfter.getTrackItems(1, false);
    const actual = [];
    for (const it of itemsAfter) {
        const s = await it.getStartTime();
        const name = await it.getName().catch(() => null);
        actual.push({ name, startSec: s && s.seconds });
    }
    actual.sort((a, b) => a.startSec - b.startSec);

    // Compare order vs desired and compute the residual offset.
    const orderMatches = actual.length === desired.length
        && desired.every((d, i) => actual[i] && actual[i].name === d.name);
    const residualOffset = actual.length > 0
        ? actual[0].startSec - 0 : 0;
    const onTarget = orderMatches && Math.abs(residualOffset) < ADDR_TOLERANCE_SEC;

    // Verify A1 ended up aligned with V1.
    const aAfter = aTrack ? await aTrack.getTrackItems(1, false) : [];
    const aActual = [];
    for (const a of aAfter) {
        const s = await a.getStartTime();
        const n = await a.getName().catch(() => null);
        aActual.push({ name: n, startSec: s && s.seconds });
    }
    aActual.sort((a, b) => a.startSec - b.startSec);

    return {
        ok: orderMatches,
        onTarget,
        orderCorrect: orderMatches,
        residualOffsetSec: residualOffset,
        totalDurationSec: totalDuration,
        pairedAudioClips: pairedAudio,
        actualLayout: actual,
        actualAudioLayout: aActual,
        note: !orderMatches
            ? "Order does not match desired - investigate."
            : (onTarget
                ? "Clips are in the desired order starting at 0s."
                : "Clips are in the desired order but the entire block "
                  + "ended up offset by " + residualOffset.toFixed(2)
                  + "s from 0. This is Premiere's ripple-remove math "
                  + "interacting with linked audio; the order is correct. "
                  + "The user can drag the block left manually if they "
                  + "want it at 0s.")
    };
}

// Probe ppro.Transcript.importFromJSON and createImportTextSegmentsAction
// to find a JSON shape + target combination Premiere accepts. We try
// several candidate JSON shapes and several targets, and for each
// attempt record exactly where the error surfaced so we can triangulate
// the right signature.

// Probe what Sequence.getCaptionTrack returns - we never enumerated its
// methods. If a caption track has direct add-item / createAdd*Action
// factories, that's a way to push captions in without the Transcript
// JSON dance.
async function probeCaptionTrack() {
    const { sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const report = { hasGetCaptionTrack: typeof sequence.getCaptionTrack === "function",
        hasGetCaptionTrackCount: typeof sequence.getCaptionTrackCount === "function" };
    let count = 0;
    try {
        if (report.hasGetCaptionTrackCount) {
            count = await sequence.getCaptionTrackCount();
        }
    } catch (e) { report.countError = e.message || String(e); }
    report.captionTrackCount = count;
    if (count === 0) {
        report.note = "No caption track exists. In Premiere: right-click "
            + "the timeline header, Add Track > Caption Track. Then re-probe.";
        return report;
    }
    const cTrack = await sequence.getCaptionTrack(0);
    report.captionTrack = {
        ctor: cTrack && cTrack.constructor && cTrack.constructor.name,
        ownKeys: cTrack ? Object.getOwnPropertyNames(cTrack) : null,
        allMethods: cTrack ? listMethods(cTrack, "") : null,
        createMethods: cTrack ? listMethods(cTrack, "create") : null,
        addMethods: cTrack ? listMethods(cTrack, "add") : null
    };
    // If the caption track has trackItems, inspect the first one to see
    // what shape a caption clip is.
    if (cTrack && typeof cTrack.getTrackItems === "function") {
        try {
            const items = await cTrack.getTrackItems(1, false);
            report.captionItemCount = items.length;
            if (items.length > 0) {
                report.firstCaptionItem = {
                    ctor: items[0].constructor && items[0].constructor.name,
                    methods: listMethods(items[0], "")
                };
            }
        } catch (e) {
            report.itemsError = e.message || String(e);
        }
    }
    return report;
}

// Try importing the absolute minimal valid transcript per Adobe's spec
// (1 speaker, 1 segment, 1 word) to the first V1 clip's source. If
// even THIS fails with "Script action failed to execute," the entire
// transcript-import code path is broken in this build regardless of
// payload, and SRT drag-drop is the realistic ceiling.
async function probeMinimalTranscriptImport() {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);
    if (!items || items.length === 0) throw new Error("V1 is empty");
    const trackItem = items[0];
    const clipItem = await trackItem.getProjectItem();
    if (!clipItem) throw new Error("Could not resolve ClipProjectItem");

    let castedClip = clipItem;
    let castMethod = "none";
    if (ppro.ClipProjectItem
        && typeof ppro.ClipProjectItem.queryCast === "function") {
        const cast = ppro.ClipProjectItem.queryCast(clipItem);
        if (cast) { castedClip = cast; castMethod = "queryCast"; }
    }

    const minimal = {
        language: "en-us",
        speakers: [{
            id: "00000000-0000-4000-8000-000000000000",
            name: "Speaker 1"
        }],
        segments: [{
            duration: 1.0, language: "en-us",
            speaker: "00000000-0000-4000-8000-000000000000",
            start: 0.0,
            words: [{
                confidence: 1.0, duration: 1.0, eos: true, start: 0.0,
                tags: [], text: "Hello", type: "word"
            }]
        }]
    };
    const json = JSON.stringify(minimal);

    const result = {
        clipCtorBefore: clipItem.constructor && clipItem.constructor.name,
        clipCtorAfter:  castedClip.constructor && castedClip.constructor.name,
        castMethod, json
    };

    // Sync parse first.
    let ts = null;
    try {
        ts = await ppro.Transcript.importFromJSON(json);
        result.syncParse = ts ? "ok" : "returned null";
    } catch (e) {
        result.syncParse = "threw: " + (e.message || String(e));
    }

    // Callback parse fallback.
    if (!ts && ppro.TextSegments
        && typeof ppro.TextSegments.importFromJSON === "function") {
        try {
            ts = await new Promise((resolve, reject) => {
                const ok = ppro.TextSegments.importFromJSON(json,
                    (parsed) => resolve(parsed));
                if (!ok) reject(new Error("returned false"));
            });
            result.callbackParse = ts ? "ok" : "callback got null";
        } catch (e) {
            result.callbackParse = "threw: " + (e.message || String(e));
        }
    }

    if (!ts) return Object.assign({ ok: false }, result,
        { error: "PARSE_FAILED" });

    result.tsCtor = ts.constructor && ts.constructor.name;

    try {
        const action = await ppro.Transcript
            .createImportTextSegmentsAction(ts, castedClip);
        result.actionBuilt = !!action;
        try {
            project.lockedAccess(() => {
                project.executeTransaction((c) => c.addAction(action),
                    "PremBot: probe minimal transcript");
            });
            result.dispatchOk = true;
            return Object.assign({ ok: true }, result);
        } catch (txErr) {
            return Object.assign({ ok: false }, result,
                { error: "DISPATCH_FAILED",
                  message: txErr.message || String(txErr) });
        }
    } catch (e) {
        return Object.assign({ ok: false }, result,
            { error: "ACTION_FACTORY_FAILED",
              message: e.message || String(e) });
    }
}

// Round-trip an existing Premiere-generated transcript so we learn
// the EXACT JSON schema. Target must be a ClipProjectItem (bin item).
// The user must have run Premiere's Speech-to-Text on the source clip
// of the first V1 trackItem for this to return real data.
async function probeTranscriptExport() {
    const { sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);
    if (!items || items.length === 0) throw new Error("V1 is empty");
    const trackItem = items[0];
    const clipProjItem = await trackItem.getProjectItem();
    if (!clipProjItem) throw new Error("Could not resolve ClipProjectItem");
    const clipName = await trackItem.getName().catch(() => null);

    let json = null, parsed = null, error = null;
    try {
        json = await ppro.Transcript.exportToJSON(clipProjItem);
        try { parsed = json ? JSON.parse(json) : null; } catch (e) {}
    } catch (e) {
        error = e && (e.message || String(e));
    }
    return {
        clipName,
        clipCtor: clipProjItem.constructor && clipProjItem.constructor.name,
        rawJsonLength: json ? json.length : 0,
        rawJsonHead: json ? json.slice(0, 1500) : null,
        parsedTopLevelKeys: parsed && typeof parsed === "object"
            ? Object.keys(parsed) : null,
        parsedSample: parsed,
        error,
        note: error
            ? "If error is 'Invalid parameter', the clip has no Premiere "
              + "transcript yet. In Premiere: Window > Text > Transcribe "
              + "Sequence (or transcribe the individual clip), wait for "
              + "it to finish, then probe again."
            : "Use parsedSample as the schema template for converting "
              + "Whisper / third-party transcripts to Premiere's format."
    };
}

// Push a JSON transcript into Premiere via the CORRECT flow per the
// skill bundle's transcripts.md:
//   1. Transcript.importFromJSON(jsonString) returns TextSegments
//   2. createImportTextSegmentsAction(textSegments, ClipProjectItem)
//   3. lockedAccess + executeTransaction
// Target is a ClipProjectItem (bin item), NOT a sequence or trackItem.
async function probeTranscriptImport() {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);
    if (!items || items.length === 0) throw new Error("V1 is empty");
    const trackItem = items[0];
    const clipProjItem = await trackItem.getProjectItem();
    if (!clipProjItem) throw new Error("Could not resolve ClipProjectItem");

    // Best-guess Adobe schemas per the skill's "general shape" hint.
    // Real schema lives at github.com/AdobeDocs/uxp-premiere-pro-samples
    // -> transcript_format_spec.json. Until we round-trip a real one
    // via probeTranscriptExport, these are educated guesses.
    const shapes = {
        speakersWordsSec: JSON.stringify({
            speakers: [{ name: "Speaker 1" }],
            segments: [
                { speaker: 0, words: [
                    { start: 0.0, end: 0.5, text: "Hello" },
                    { start: 0.6, end: 1.2, text: "world." }
                ] }
            ]
        }),
        speakersWordsStartTime: JSON.stringify({
            speakers: [{ name: "Speaker 1" }],
            segments: [
                { speaker: 0, words: [
                    { startTime: 0.0, endTime: 0.5, word: "Hello" },
                    { startTime: 0.6, endTime: 1.2, word: "world." }
                ] }
            ]
        }),
        adobePremiereFormat: JSON.stringify({
            format: "premiere-pro-transcript", version: "1.0",
            language: "en-US",
            speakers: [{ id: 0, name: "Speaker 1" }],
            segments: [
                { speakerId: 0, words: [
                    { start: 0.0, end: 0.5, text: "Hello" },
                    { start: 0.6, end: 1.2, text: "world." }
                ] }
            ]
        })
    };

    const out = {
        clipCtor: clipProjItem.constructor && clipProjItem.constructor.name,
        attempts: []
    };

    for (const [shapeName, json] of Object.entries(shapes)) {
        const attempt = { shape: shapeName, jsonBytes: json.length };
        let textSegments = null;
        try {
            textSegments = await ppro.Transcript.importFromJSON(json);
            attempt.parseOk = !!textSegments;
            attempt.tsCtor = textSegments && textSegments.constructor
                && textSegments.constructor.name;
        } catch (e) {
            attempt.parseError = e && (e.message || String(e));
        }
        if (textSegments) {
            try {
                const action = await ppro.Transcript
                    .createImportTextSegmentsAction(textSegments, clipProjItem);
                attempt.actionBuilt = !!action;
                try {
                    project.lockedAccess(() => {
                        project.executeTransaction((c) => c.addAction(action),
                            "PremBot: probe import transcript");
                    });
                    attempt.dispatchOk = true;
                } catch (txErr) {
                    attempt.dispatchError = txErr && (txErr.message || String(txErr));
                }
            } catch (e) {
                attempt.actionError = e && (e.message || String(e));
            }
        }
        out.attempts.push(attempt);
        if (attempt.dispatchOk) { out.winner = shapeName; break; }
    }
    return out;
}

// Diagnostic: probe ppro.Transcript and the first V1 clip's project item
// for transcript-related methods. We want to know:
//   - What static methods exist on ppro.Transcript and ppro.TextSegments
//   - Whether a project item exposes a getTranscript / hasTranscript path
//   - What a transcript object looks like (segments, words, timestamps)
async function probeTranscript() {
    const { project, sequence } = await getContext();
    const report = {
        TranscriptStatic: ppro.Transcript
            ? Object.getOwnPropertyNames(ppro.Transcript) : null,
        TranscriptStaticMethods: ppro.Transcript
            ? listMethods(ppro.Transcript, "") : null,
        TextSegmentsStatic: ppro.TextSegments
            ? Object.getOwnPropertyNames(ppro.TextSegments) : null,
        TextSegmentsStaticMethods: ppro.TextSegments
            ? listMethods(ppro.TextSegments, "") : null
    };

    // Try a couple of likely static getters with a real project item.
    let firstProjItem = null;
    try {
        if (sequence) {
            const track = await sequence.getVideoTrack(0);
            const items = await track.getTrackItems(1, false);
            if (items.length > 0 && typeof items[0].getProjectItem === "function") {
                firstProjItem = await items[0].getProjectItem();
            }
        }
        if (!firstProjItem) {
            const root = await project.getRootItem();
            const all = await root.getItems();
            if (all.length > 0) firstProjItem = all[0];
        }
    } catch (e) {}

    if (firstProjItem) {
        report.projectItemName = firstProjItem.name;
        report.projectItemMethods = listMethods(firstProjItem, "");

        // The Transcript class exposes only importFromJSON / exportToJSON.
        // Probe exportToJSON with multiple arg shapes to find which
        // anchor type Premiere uses (projectItem? sequence? trackItem?
        // no-arg / "active"?).
        const trackItem = (sequence)
            ? (await (await sequence.getVideoTrack(0)).getTrackItems(1, false))[0]
            : null;
        const tries = [
            ["ppro.Transcript.exportToJSON()",
                async () => await ppro.Transcript.exportToJSON()],
            ["ppro.Transcript.exportToJSON(projItem)",
                async () => await ppro.Transcript.exportToJSON(firstProjItem)],
            ["ppro.Transcript.exportToJSON(sequence)",
                async () => sequence
                    ? await ppro.Transcript.exportToJSON(sequence) : null],
            ["ppro.Transcript.exportToJSON(trackItem)",
                async () => trackItem
                    ? await ppro.Transcript.exportToJSON(trackItem) : null]
        ];
        const attempts = [];
        for (const [label, fn] of tries) {
            try {
                const result = await fn();
                const rep = { tried: label,
                    resultType: typeof result,
                    resultCtor: result && result.constructor && result.constructor.name,
                    resultValue: null,
                    resultKeys: null,
                    resultMethods: null
                };
                if (typeof result === "string") {
                    rep.resultValue = result.length > 800
                        ? result.slice(0, 800) + "...(+" + (result.length - 800) + ")"
                        : result;
                } else if (result && typeof result === "object") {
                    rep.resultKeys = Object.keys(result);
                    rep.resultMethods = listMethods(result, "");
                }
                attempts.push(rep);
                if (result && (typeof result === "string"
                        || (typeof result === "object" && Object.keys(result).length))) {
                    report.firstHit = { label, type: typeof result };
                    break;
                }
            } catch (e) {
                attempts.push({ tried: label, error: e.message || String(e) });
            }
        }
        report.attempts = attempts;
    }
    return report;
}

// Diagnostic: ripple-delete probe. Remove ONE middle clip from V1 with
// createRemoveItemsAction(sel, true, null) and report whether clips
// after it slid back by the removed clip's duration. If the deltas
// match, we have a ripple primitive and can build reverse on top of it.
async function probeRippleDelete() {
    const { project, sequence, editor } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    if (!editor)   throw new Error("Could not get SequenceEditor");
    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);
    if (items.length < 3) {
        throw new Error("Need at least 3 clips on V1 for a meaningful probe");
    }
    const targetIdx = Math.floor(items.length / 2);
    const target = items[targetIdx];
    const sT = await target.getStartTime();
    const eT = await target.getEndTime();
    const targetStart = sT && sT.seconds;
    const targetEnd   = eT && eT.seconds;
    const targetDuration = targetEnd - targetStart;
    const targetName = await target.getName().catch(() => null);

    // Snapshot of every clip's start BEFORE.
    const before = [];
    for (const it of items) {
        const s = await it.getStartTime();
        before.push({
            name: await it.getName().catch(() => null),
            start: s && s.seconds
        });
    }

    // Remove with ripple = true (second arg).
    const sel = await sequence.getSelection();
    if (typeof sequence.clearSelection === "function") {
        try { await sequence.clearSelection(); } catch (e) {}
    }
    await sel.addItem(target);
    const action = await editor.createRemoveItemsAction(sel, true, null);
    project.lockedAccess(() => {
        project.executeTransaction((c) => c.addAction(action),
            "PremBot: probe ripple-delete");
    });

    // Snapshot AFTER.
    const trackAfter = await sequence.getVideoTrack(0);
    const itemsAfter = await trackAfter.getTrackItems(1, false);
    const after = [];
    for (const it of itemsAfter) {
        const s = await it.getStartTime();
        after.push({
            name: await it.getName().catch(() => null),
            start: s && s.seconds
        });
    }

    // For each clip that was AFTER the target, check whether its
    // start dropped by exactly targetDuration (ripple) or stayed put
    // (non-ripple).
    const analysis = [];
    for (const b of before) {
        if (b.name === targetName) continue; // the deleted one
        const a = after.find((x) => x.name === b.name);
        if (!a) {
            analysis.push({ name: b.name, before: b.start,
                note: "missing after" });
            continue;
        }
        const delta = a.start - b.start;
        analysis.push({
            name: b.name,
            wasAfterTarget: b.start > targetStart,
            before: b.start, after: a.start, delta
        });
    }

    const postClips = analysis.filter((x) => x.wasAfterTarget);
    const rippled = postClips.length > 0
        && postClips.every((x) => Math.abs(x.delta + targetDuration) < ADDR_TOLERANCE_SEC);

    return {
        targetName, targetStart, targetEnd, targetDuration,
        ripplePrimitiveWorks: rippled,
        analysis
    };
}

// ---- Diagnostics: factory probe (kept for future debugging) ----

function listMethods(obj, prefix) {
    if (!obj) return [];
    const seen = new Set();
    let proto = obj;
    while (proto && proto !== Object.prototype) {
        for (const k of Object.getOwnPropertyNames(proto)) {
            if (k === "constructor") continue;
            if (prefix && !k.startsWith(prefix)) continue;
            try {
                if (typeof obj[k] === "function") seen.add(k);
            } catch (e) {}
        }
        proto = Object.getPrototypeOf(proto);
    }
    return Array.from(seen).sort();
}

async function probeFactories() {
    const { project, sequence, editor } = await getContext();
    const report = {
        pproTopLevel: Object.keys(ppro).sort(),
        projectMethods: listMethods(project, ""),
        sequenceMethods: sequence ? listMethods(sequence, "") : null,
        editorMethods:  editor ? listMethods(editor, "") : null
    };
    if (sequence) {
        const vCount = await sequence.getVideoTrackCount();
        if (vCount > 0) {
            const track = await sequence.getVideoTrack(0);
            report.trackMethods = listMethods(track, "");
            const items = await track.getTrackItems(1, false);
            if (items && items.length > 0) {
                report.trackItemMethods = listMethods(items[0], "");
            }
        }
    }
    return report;
}

// ---- Panel wiring ----

function showResult(out, label, value) {
    const json = (() => {
        try { return JSON.stringify(value, null, 2); }
        catch (e) { return String(value); }
    })();
    out.textContent = "[" + new Date().toLocaleTimeString() + "] "
        + label + "\n\n" + json;
}

function showError(out, label, err) {
    out.textContent = "[" + new Date().toLocaleTimeString() + "] "
        + label + " FAILED\n\n"
        + (err && (err.stack || err.message || String(err)));
}

function bind(root, id, label, fn) {
    const btn = root.querySelector("#" + id);
    if (!btn) return;
    btn.addEventListener("click", async () => {
        const out = root.querySelector("#output");
        out.textContent = label + "...";
        try { showResult(out, label, await fn()); }
        catch (e) { showError(out, label, e); }
    });
}

function attach(root) {
    bind(root, "btn-ping",      "ping",                ping);
    bind(root, "btn-project",   "listProjectClips",    listProjectClips);
    bind(root, "btn-sequence",  "listSequenceClips",   listSequenceClips);
    bind(root, "btn-probe",     "probeFactories",      probeFactories);

    bind(root, "btn-move",      "move V1 first clip -> 5s",
        async () => {
            const { sequence } = await getContext();
            const t = await sequence.getVideoTrack(0);
            const items = await t.getTrackItems(1, false);
            if (items.length === 0) throw new Error("V1 is empty");
            const s = await items[0].getStartTime();
            return moveClip(0, s.seconds, 5);
        });
    bind(root, "btn-clone",     "clone V1 first clip -> end of V1",
        async () => {
            const { sequence } = await getContext();
            const t = await sequence.getVideoTrack(0);
            const items = await t.getTrackItems(1, false);
            if (items.length === 0) throw new Error("V1 is empty");
            const s = await items[0].getStartTime();
            const last = items[items.length - 1];
            const lastEnd = last ? await last.getEndTime() : null;
            const target = (lastEnd && lastEnd.seconds) || 0;
            return cloneClipToTime(0, s.seconds, target);
        });
    bind(root, "btn-disable",   "toggle disable V1 first clip",
        async () => {
            const { sequence } = await getContext();
            const t = await sequence.getVideoTrack(0);
            const items = await t.getTrackItems(1, false);
            if (items.length === 0) throw new Error("V1 is empty");
            const s = await items[0].getStartTime();
            const cur = await items[0].isDisabled();
            return setClipDisabled(0, s.seconds, !cur);
        });
    bind(root, "btn-clear-v1",  "clearV1",             clearV1);
    bind(root, "btn-probe-ripple", "probeRippleDelete", probeRippleDelete);
    bind(root, "btn-probe-transcript", "probeTranscript", probeTranscript);
    bind(root, "btn-probe-import",     "probeTranscriptImport", probeTranscriptImport);
    bind(root, "btn-probe-caption",    "probeCaptionTrack",     probeCaptionTrack);
    bind(root, "btn-probe-export-tx",  "probeTranscriptExport", probeTranscriptExport);
    bind(root, "btn-probe-export",     "probeExportApis", probeExportApis);
    bind(root, "btn-probe-export-live", "probeFrameExportLive",
        probeFrameExportLive);
    bind(root, "btn-probe-export-readback", "probeFrameExportReadback",
        probeFrameExportReadback);
    bind(root, "btn-probe-min-tx",     "probeMinimalTranscriptImport",
        probeMinimalTranscriptImport);

    const out = root.querySelector("#output");
    const copyStatus = root.querySelector("#copy-status");
    root.querySelector("#btn-copy").addEventListener("click", async () => {
        const text = out.textContent || "";
        try {
            await navigator.clipboard.writeText(text);
            copyStatus.textContent = "Copied " + text.length + " chars";
        } catch (e) {
            copyStatus.textContent = "Copy failed: " + (e && (e.message || e));
        }
        setTimeout(() => { copyStatus.textContent = ""; }, 3000);
    });
}

// ---- Expose primitives to agent.js via globalThis ----
//
// Each export takes a single `input` object so it lines up cleanly with
// Anthropic's tool-use schema (block.input is a JSON object).

// ---- Transcript-driven editing: bridge timeline clips to transcripts ----
//
// For each V1 clip, find the cached transcript whose source file name
// "looks like" the same clip. Both names are normalized by stripping
// the extension and common audio-extraction suffixes (_audio, .audio).
// e.g. V1 clip "ElfonShelf(final).mp4" matches transcript source
// "E:\\Video\\ElfonShelf_audio.mp3" after both normalize to
// "elfonshelf(final)" / "elfonshelf".

// Reduce a filename to a key we can compare across the V1 / audio
// divide. Examples that should all collide on the same key:
//   "ElfonShelf(final).mp4"      -> "elfonshelf"
//   "E:\\Video\\ElfonShelf_audio.mp3" -> "elfonshelf"
//   "ElfonShelf-720p.mov"         -> "elfonshelf"
//
// Strips: directories, extension, audio-extraction suffixes
// (_audio/_track/_mix), resolution tags (_720p), and parenthetical
// modifiers like "(final)" / "(v2)".
function normalizeClipKey(name) {
    if (!name) return "";
    const base = String(name).replace(/\\/g, "/")
        .split("/").pop().toLowerCase();
    let key = base.replace(/\.[^.]+$/, "");
    // Strip trailing parenthetical groups (e.g. "(final)", "(v2)")
    key = key.replace(/\s*\([^)]*\)\s*$/, "");
    // Strip audio-extraction suffixes anywhere at the end
    key = key.replace(/[_.\- ](?:audio|track|mix)$/, "");
    // Strip resolution / quality tags at the end
    key = key.replace(/[_.\- ]\d{3,4}p$/, "");
    return key.trim();
}

// Find exact timeline positions (start + end seconds) of given words in
// V1 clips' cached transcripts. Returns nothing if no transcript is
// cached for a clip - call transcribe_v1_clips first.
async function findWordPositionsInV1(words) {
    const { sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const transcripts = globalThis.PremBotTranscripts;
    if (!transcripts) throw new Error("Transcripts module not loaded");

    const cached = transcripts.listCachedTranscripts();
    if (cached.length === 0) {
        return { hits: [], note: "No transcripts cached. Call "
            + "transcribe_v1_clips first." };
    }
    const byKey = new Map();
    for (const c of cached) {
        byKey.set(normalizeClipKey(c.name), c);
        byKey.set(normalizeClipKey(c.sourcePath), c);
    }
    const wordSet = new Set(
        (words || []).map((w) => String(w).toLowerCase().trim()));

    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);

    const hits = [];
    for (const item of items) {
        const clipName = await item.getName().catch(() => null);
        const sT = await item.getStartTime();
        const iT = await item.getInPoint();
        const timelineStart = sT && sT.seconds;
        const sourceIn      = (iT && iT.seconds) || 0;
        if (typeof timelineStart !== "number") continue;

        const key = normalizeClipKey(clipName);
        const transcriptMeta = byKey.get(key);
        if (!transcriptMeta) continue;
        const full = transcripts.getClipTranscript(transcriptMeta.sourcePath);
        if (!full || !full.words || full.words.length === 0) continue;

        // Whisper sometimes returns degenerate word timings (duration 0,
        // adjacent words at the same start). For markers / razor-cut
        // workflows, expand any near-zero duration to a typical word
        // length (~0.3s) so users get a usable range.
        const TYPICAL_WORD_SEC = 0.3;
        for (const w of full.words) {
            const text = String(w.word || "").trim();
            const norm = text.toLowerCase().replace(/^[^\w']+|[^\w']+$/g, "");
            if (!wordSet.has(norm)) continue;
            const rawStart    = w.startSec;
            const rawEnd      = w.endSec;
            const rawDuration = rawEnd - rawStart;
            const effDuration = rawDuration > 0.05
                ? rawDuration : TYPICAL_WORD_SEC;
            const timelineSec    = timelineStart + (rawStart - sourceIn);
            const timelineEndSec = timelineSec + effDuration;
            if (timelineSec < timelineStart - 0.001) continue;
            hits.push({
                clipName,
                v1_currentStartSeconds: timelineStart,
                word: text,
                timelineStartSec: timelineSec,
                timelineEndSec,
                durationSec: effDuration,
                durationWasClamped: rawDuration <= 0.05
            });
        }
    }
    return { words: Array.from(wordSet), hits, hitCount: hits.length };
}

// Same scan as findWordPositionsInV1, but also drops a Premiere marker
// at each hit so the user can navigate to filler-word positions
// visually and use Premiere's Razor tool (C) + delete to trim them.
// Premiere's createAddMarkerAction is documented as canonical; this
// build may or may not honor it - if the factory throws we still
// return the hit data.
async function addMarkersForWords(words) {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const scan = await findWordPositionsInV1(words);
    if (scan.hitCount === 0) return Object.assign({ markersAdded: 0 }, scan);

    // Discover Markers API in this build. ppro.Markers.createAddMarkerAction
    // (canonical per skill) doesn't exist in 26.2.2. Try alternatives:
    // an instance from Markers.getMarkers(sequence), or createAddAction
    // on the instance, or a sequence-side createAddMarkerAction.
    const probe = {
        Markers_static: Object.getOwnPropertyNames(ppro.Markers || {}),
        Markers_create: ppro.Markers ? listMethods(ppro.Markers, "create") : null
    };
    let markersInstance = null;
    let instanceMethods = null;
    try {
        if (ppro.Markers && typeof ppro.Markers.getMarkers === "function") {
            markersInstance = await ppro.Markers.getMarkers(sequence);
        }
    } catch (e) { probe.getMarkersError = e.message || String(e); }
    if (markersInstance) {
        probe.instance_ctor = markersInstance.constructor
            && markersInstance.constructor.name;
        instanceMethods = listMethods(markersInstance, "");
        probe.instance_create = listMethods(markersInstance, "create");
        probe.instance_add    = listMethods(markersInstance, "add");
    }

    const seqCreateMarker = sequence && typeof sequence.createAddMarkerAction
        === "function";
    probe.sequence_has_createAddMarkerAction = seqCreateMarker;

    async function buildAction(hit, start, dur) {
        // Try a range of signatures across all discovered surfaces. Capture
        // the failure reason from each so we can see what Premiere wants.
        const tries = [];
        const m = markersInstance;
        if (m && typeof m.createAddMarkerAction === "function") {
            tries.push(["instance.createAddMarkerAction(5: name,type,start,dur,comments)",
                () => m.createAddMarkerAction(hit.word, "Comment", start, dur, "PremBot")]);
            tries.push(["instance.createAddMarkerAction(4: name,type,start,dur)",
                () => m.createAddMarkerAction(hit.word, "Comment", start, dur)]);
            tries.push(["instance.createAddMarkerAction(3: name,start,dur)",
                () => m.createAddMarkerAction(hit.word, start, dur)]);
            tries.push(["instance.createAddMarkerAction(2: name,start)",
                () => m.createAddMarkerAction(hit.word, start)]);
            tries.push(["instance.createAddMarkerAction(type=\"\")",
                () => m.createAddMarkerAction(hit.word, "", start, dur, "")]);
            tries.push(["instance.createAddMarkerAction(type=comment lc)",
                () => m.createAddMarkerAction(hit.word, "comment", start, dur, "")]);
        }
        const attemptLog = [];
        for (const [label, fn] of tries) {
            try {
                const a = await fn();
                if (a) return { action: a, api: label, attempts: attemptLog };
                attemptLog.push({ tried: label, result: "returned null" });
            } catch (e) {
                attemptLog.push({ tried: label,
                    error: e && (e.message || String(e)) });
            }
        }
        return { action: null, api: null, attempts: attemptLog };
    }

    const actions = [];
    let usedApi = null;
    for (const hit of scan.hits) {
        const start = await ppro.TickTime.createWithSeconds(hit.timelineStartSec);
        const dur   = await ppro.TickTime.createWithSeconds(
            Math.max(0.01, hit.durationSec));
        const { action, api, attempts } = await buildAction(hit, start, dur);
        if (!action) {
            return Object.assign({
                markersAdded: 0, markerProbe: probe,
                markerAttempts: attempts,
                markerError: "All marker-add signatures failed. See "
                    + "markerAttempts for per-call errors.",
                hint: "Time ranges below are accurate - use Premiere's Razor "
                    + "tool (C) at each timelineStartSec to cut, then delete "
                    + "the middle pieces manually."
            }, scan);
        }
        if (!usedApi) usedApi = api;
        actions.push(action);
    }

    try {
        project.lockedAccess(() => {
            project.executeTransaction((c) => {
                for (const a of actions) c.addAction(a);
            }, "PremBot: add markers for filler words");
        });
    } catch (txErr) {
        return Object.assign({
            markersAdded: 0, markerProbe: probe, markerApi: usedApi,
            dispatchError: txErr && (txErr.message || String(txErr))
        }, scan);
    }
    return Object.assign({ markersAdded: actions.length, markerApi: usedApi,
        markerProbe: probe }, scan);
}

async function findV1ClipsMatching(query) {
    const { sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const transcripts = globalThis.PremBotTranscripts;
    if (!transcripts) throw new Error("Transcripts module not loaded");

    const cached = transcripts.listCachedTranscripts();
    if (cached.length === 0) {
        return { results: [], note: "No transcripts cached. Call "
            + "transcribe_media_file first for the relevant audio." };
    }
    // Build index: normalizedKey -> cached transcript entry
    const byKey = new Map();
    for (const c of cached) {
        byKey.set(normalizeClipKey(c.name), c);
        byKey.set(normalizeClipKey(c.sourcePath), c);
    }

    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);

    const q = String(query || "").trim().toLowerCase();
    const results = [];
    for (const item of items) {
        const name = await item.getName().catch(() => null);
        const sT = await item.getStartTime();
        const currentStartSeconds = sT && sT.seconds;
        const key = normalizeClipKey(name);
        const match = byKey.get(key);
        if (!match) continue;
        // Fetch the full transcript and find segments containing q
        const full = transcripts.getClipTranscript(match.sourcePath);
        if (!full) continue;
        const hits = q
            ? full.segments.filter((s) =>
                String(s.text).toLowerCase().includes(q))
            : full.segments;
        if (q && hits.length === 0) continue;
        results.push({
            v1_currentStartSeconds: currentStartSeconds,
            clipName: name,
            transcriptSource: match.sourcePath,
            matchingSegments: hits.map((s) => ({
                startSec: s.startSec, endSec: s.endSec, text: s.text
            })),
            fullSegmentCount: full.segments.length
        });
    }
    return { query: q, results,
        totalV1Clips: items.length, totalMatched: results.length };
}

// ---- Frame export (color grading / vision) ----
//
// `Sequence.exportFrameJPEG` / `exportFramePNG` are absent from
// Premiere 26.2.2's ExtendScript surface, so the CEP path can't do
// this. The UXP API has it under `Utils.exportSequenceFrame` (T1) -
// we use that here, then read the file back through UXP storage and
// base64-encode for transit into the conversation.

async function findClipAtTimeOnV1(sequence, atSec) {
    const track = await sequence.getVideoTrack(0);
    if (!track) return null;
    const items = await track.getTrackItems(1, false);
    for (let ci = 0; ci < items.length; ci++) {
        const clip = items[ci];
        const s = await clip.getStartTime();
        const e = await clip.getEndTime();
        const sSec = s && s.seconds;
        const eSec = e && e.seconds;
        if (typeof sSec === "number" && typeof eSec === "number"
            && atSec >= sSec - 0.001 && atSec < eSec + 0.001) {
            const name = await clip.getName().catch(() => null);
            return {
                clipIndex: ci, clipName: name,
                startSec: sSec, endSec: eSec,
                timeIntoClipSec: atSec - sSec,
                durationSec: eSec - sSec
            };
        }
    }
    return null;
}

// Convert an ArrayBuffer to base64 using btoa over a one-byte-per-char
// binary string. Fine for a few MB; we'd switch to a chunked encoder
// if frames ever got truly large.
function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null,
            bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(binary);
}

// API name lottery: the Premiere UXP frame-export entry point has
// moved between releases. Cache the winning candidate after the first
// successful call so we don't redo the probe per-frame.
let __frameApi = null;       // { kind: "ns"|"instance", path: "ppro.Utils.exportSequenceFrame", fn: function }
let __frameApiProbed = false;

// Real signature from @adobe/premierepro src/premierepro.d.ts:
//
//   exportSequenceFrame(
//     sequence: Sequence,
//     time: TickTime,
//     filename: string,    // bare filename, e.g. "frame.png"
//     filepath: string,    // directory, e.g. "C:/temp/"
//     width: number,
//     height: number
//   ): Promise<boolean>
//
// "filename" and "filepath" are SEPARATE - the directory and the
// bare name aren't concatenated. Supported formats are inferred
// from the filename extension (bmp/dpx/gif/jpg/exr/png/tga/tif).
async function probeFrameApis(sequence, exportOpts) {
    let frameSize = null;
    let fsWidth = 1920, fsHeight = 1080;
    try {
        if (typeof sequence.getFrameSize === "function") {
            frameSize = await sequence.getFrameSize();
            if (frameSize) {
                if (typeof frameSize.width === "number")  fsWidth  = frameSize.width;
                if (typeof frameSize.height === "number") fsHeight = frameSize.height;
            }
        }
    } catch (e) {}

    // Resolve final export dimensions. maxDim caps the longest edge
    // while preserving aspect ratio - used by vision flows to keep
    // image tokens manageable without losing color information. An
    // explicit width/height override bypasses maxDim.
    let outW = fsWidth, outH = fsHeight;
    if (exportOpts && (exportOpts.width || exportOpts.height)) {
        outW = exportOpts.width  || outW;
        outH = exportOpts.height || outH;
    } else if (exportOpts && exportOpts.maxDim) {
        const ratio = fsWidth / fsHeight;
        const m = exportOpts.maxDim;
        if (fsWidth >= fsHeight) {
            outW = m;
            outH = Math.round(m / ratio);
        } else {
            outH = m;
            outW = Math.round(m * ratio);
        }
    }
    // Build a list of (description, callable) candidates. Each callable
    // accepts (tickTime, outPath) and is responsible for adapting to
    // whichever signature the underlying method actually uses.
    //
    // First call with (seq, tt, path) returned "Not Enough Parameters",
    // so the real signature has more than 3 args. We use Function.length
    // (the function's declared arity) to spell each variant, and try
    // signatures with common fill values for the extra slots:
    //   - width / height integers (Premiere often takes pixel dims)
    //   - format strings ("JPEG", "PNG")
    //   - empty / null filler
    const candidates = [];

    function pushExporterVariant(method, methodName) {
        // Function.length is 0 on host bindings here, so arity is no
        // signal - we have to try variations. Time encoding varies too,
        // so for each shape we also try the time arg as a TickTime
        // object, a ticks-string, and a raw seconds number.
        function resolveFiller(filler, tt) {
            if (filler === "__FRAMESIZE__") return frameSize;
            if (filler === "__SAME_TT__")   return tt;
            return filler;
        }
        function pushShape(label, fillerArgs) {
            const fillers = fillerArgs || [];
            const timeForms = [
                ["TickTime", (tt) => tt],
                ["ticksStr", (tt) => String(tt && tt.ticks)],
                ["sec", (tt) => tt && tt.seconds]
            ];
            for (const [tname, conv] of timeForms) {
                candidates.push({
                    path: "ppro.Exporter." + methodName + "("
                        + label.replace(/\btt\b/g, "tt:" + tname) + ")",
                    kind: "ns",
                    fn: (tt, p) => method(sequence, conv(tt), p,
                        ...fillers.map((f) => resolveFiller(f, tt)))
                });
            }
        }
        pushShape("seq,tt,path");
        pushShape("seq,tt,path,JPEG", ["JPEG"]);
        pushShape("seq,tt,path,jpeg", ["jpeg"]);
        pushShape("seq,tt,path,PNG",  ["PNG"]);
        pushShape("seq,tt,path,1920,1080", [1920, 1080]);
        pushShape("seq,tt,path,1920,1080,JPEG", [1920, 1080, "JPEG"]);
        pushShape("seq,tt,path,frameSize", ["__FRAMESIZE__"]);
        pushShape("seq,tt,path,frameSize,JPEG", ["__FRAMESIZE__", "JPEG"]);
        pushShape("seq,tt,path,null", [null]);
        pushShape("seq,tt,path,empty", [""]);
        pushShape("seq,tt,path,tt,tt,JPEG", ["__SAME_TT__", "__SAME_TT__", "JPEG"]);

        // (tt, path) shape - method may resolve the sequence itself.
        candidates.push({
            path: "ppro.Exporter." + methodName + "(tt,path)",
            kind: "ns",
            fn: (tt, p) => method(tt, p)
        });
    }

    // Canonical signature only - confirmed from premierepro.d.ts.
    // outW/outH are the export dimensions (full sequence size by
    // default, scaled to a maxDim cap for vision flows).
    if (ppro.Exporter
        && typeof ppro.Exporter.exportSequenceFrame === "function") {
        candidates.push({
            path: "ppro.Exporter.exportSequenceFrame",
            kind: "ns",
            fn: (tt, filename, filepath) =>
                ppro.Exporter.exportSequenceFrame(
                    sequence, tt, filename, filepath, outW, outH)
        });
    }
    return candidates;
}

let __frameCounter = 0;
async function exportFrameAt(atSec, exportOpts) {
    const { sequence } = await getContext();
    if (!sequence) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };

    let secs = (typeof atSec === "number") ? atSec : null;
    if (secs === null) {
        try {
            const pos = await sequence.getPlayerPosition();
            secs = pos && pos.seconds;
        } catch (e) {
            return { ok: false, error: "NO_PLAYER_POSITION",
                message: e && (e.message || String(e)) };
        }
    }
    if (typeof secs !== "number") {
        return { ok: false, error: "NO_PLAYER_POSITION" };
    }

    const tickTime = await ppro.TickTime.createWithSeconds(secs);
    const uxp = require("uxp");
    const fs  = uxp.storage.localFileSystem;
    const temp = await fs.getTemporaryFolder();

    // Empirical findings from probeFrameExportLive on Premiere 26.2.2:
    //
    // - Filename must use the .jpg extension. The .d.ts docstring lists
    //   bmp/dpx/gif/jpg/exr/png/tga/tif but only .jpg worked here -
    //   .jpeg threw "File Format is not supported", .png returned false.
    // - filepath must use the OS-native separator (backslash on Windows)
    //   with a trailing separator. Forward slashes - even matching the
    //   .d.ts example 'C:/temp/' - return false.
    // - width/height must be numbers, not numeric strings ("Illegal
    //   Parameter type").
    async function tryCandidate(cand) {
        __frameCounter++;
        const filename = "prembot-frame-" + Date.now() + "-"
            + __frameCounter + ".jpg";
        let filepath = temp.nativePath;
        const sep = filepath.indexOf("\\") >= 0 ? "\\" : "/";
        if (!filepath.endsWith(sep)) filepath += sep;

        let rc;
        try { rc = await cand.fn(tickTime, filename, filepath); }
        catch (e) { return { ok: false,
            error: "EXPORT_FRAME_THREW", path: cand.path,
            message: e && (e.message || String(e)) }; }
        if (rc === false) return { ok: false,
            error: "EXPORT_FRAME_RETURNED_FALSE", path: cand.path };

        // Premiere's exportSequenceFrame Promise resolves BEFORE the
        // file is fully flushed to disk. The readback probe confirmed
        // a 250 ms wait makes any URL form work; without it, even
        // getEntryWithUrl on the exact path fails ("Could not find an
        // entry of ..."). Poll with short backoffs so the typical case
        // (write already flushed by the time we look) doesn't pay the
        // worst-case latency.
        let buf;
        let readErr = null;
        const backoffs = [0, 50, 100, 200, 400, 600];
        for (let i = 0; i < backoffs.length; i++) {
            if (backoffs[i] > 0) {
                await new Promise((r) => setTimeout(r, backoffs[i]));
            }
            try {
                const written = await temp.getEntry(filename);
                buf = await written.read({ format: uxp.storage.formats.binary });
                if (buf && buf.byteLength > 0) { readErr = null; break; }
            } catch (e) {
                readErr = e && (e.message || String(e));
            }
        }
        if (!buf || buf.byteLength === 0) {
            return { ok: false, error: "EXPORT_FRAME_READ_FAILED",
                path: cand.path,
                message: readErr || "file empty after retries" };
        }
        if (!buf || buf.byteLength === 0) {
            return { ok: false, error: "EXPORT_FRAME_EMPTY_FILE",
                path: cand.path };
        }
        return { ok: true, buf, outPath: filepath + filename };
    }

    // If we already know which API works, use it directly.
    const candidates = await probeFrameApis(sequence, exportOpts);
    if (candidates.length === 0) {
        return { ok: false, error: "NO_EXPORT_FRAME_API",
            message: "No candidate frame-export function found. Run "
                + "the Diagnostics 'Probe frame-export APIs' button for "
                + "the full surface dump." };
    }

    let order = candidates;
    if (__frameApi) {
        // Promote the cached winner to front. Past wins are exact-
        // signature paths, so direct match.
        order = [
            ...candidates.filter((c) => c.path === __frameApi.path),
            ...candidates.filter((c) => c.path !== __frameApi.path)
        ];
    }

    let firstErrMsg = null;
    let triedCount = 0;
    for (const cand of order) {
        const r = await tryCandidate(cand);
        triedCount++;
        if (r.ok) {
            __frameApi = { path: cand.path, kind: cand.kind };
            __frameApiProbed = true;
            const base64 = arrayBufferToBase64(r.buf);
            const clipAtPlayhead = await findClipAtTimeOnV1(sequence, secs);
            return { ok: true, path: r.outPath, mediaType: "image/jpeg",
                atSec: secs, base64, byteLength: r.buf.byteLength,
                clipAtPlayhead, viaApi: cand.path };
        }
        // Surface the inner error CODE when there's no message - the
        // failure paths EXPORT_FRAME_RETURNED_FALSE and EMPTY_FILE
        // don't have a message attached; the code is what we need.
        if (firstErrMsg === null) {
            firstErrMsg = r.message
                || (r.error ? "(no msg, code=" + r.error + ")" : "(none)");
        }
    }
    // Minimal failure payload (~80 bytes) - the model just needs to know
    // vision is unavailable on this build and to switch strategies. Full
    // diagnostic detail lives in the Diagnostics > Probe button.
    return { ok: false, error: "FRAME_EXPORT_UNAVAILABLE",
        message: "Tried " + triedCount + "; first: "
            + (firstErrMsg || "(none)") };
}

// Detailed report of what export-shaped surface exists. Returned on
// failure (and from probe_export_apis) so the user / agent has the
// info needed to add a missing candidate without another round-trip.
function surfaceReportForExport(sequence) {
    function keysWithTypes(obj) {
        if (!obj) return null;
        const out = [];
        try {
            for (const k of Object.keys(obj)) {
                let t = "unknown";
                try { t = typeof obj[k]; } catch (e) {}
                out.push(k + ":" + t);
            }
        } catch (e) {}
        return out.sort();
    }
    function allMethods(obj) {
        if (!obj) return null;
        const seen = new Set();
        let proto = obj;
        while (proto && proto !== Object.prototype) {
            for (const k of Object.getOwnPropertyNames(proto)) {
                if (k === "constructor") continue;
                try { if (typeof obj[k] === "function") seen.add(k); }
                catch (e) {}
            }
            proto = Object.getPrototypeOf(proto);
        }
        return Array.from(seen).sort();
    }
    return {
        ppro_top_keys: Object.keys(ppro).sort(),
        ppro_Utils_keys:         keysWithTypes(ppro.Utils),
        ppro_SequenceUtils_keys: keysWithTypes(ppro.SequenceUtils),
        ppro_ProjectUtils_keys:  keysWithTypes(ppro.ProjectUtils),
        ppro_Exporter_keys:      keysWithTypes(ppro.Exporter),
        ppro_EncoderManager_keys: keysWithTypes(ppro.EncoderManager),
        ppro_SourceMonitor_keys: keysWithTypes(ppro.SourceMonitor),
        sequence_all_methods:    allMethods(sequence)
    };
}

// Live test of frame export: actually CALL the function with several
// argument permutations and report the rc for each. This finds out
// quickly which combo Premiere accepts (path format, extension,
// dimensions, time-relativity) without burning an API roundtrip per
// attempt.
async function probeFrameExportLive() {
    const { sequence } = await getContext();
    if (!sequence) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };
    if (!ppro.Exporter
        || typeof ppro.Exporter.exportSequenceFrame !== "function") {
        return { ok: false, error: "NO_EXPORT_API" };
    }

    const uxp = require("uxp");
    const os  = require("os");
    const fs  = uxp.storage.localFileSystem;
    const temp = await fs.getTemporaryFolder();

    // Source the test time from the active playhead so it's known
    // valid (within the sequence). Pull frame size for the canonical
    // call.
    let pos;
    try { pos = await sequence.getPlayerPosition(); }
    catch (e) { return { ok: false, error: "NO_PLAYER_POSITION",
        message: e && (e.message || String(e)) }; }
    const tt = pos;   // TickTime as returned by Premiere itself
    let fsObj = null;
    try { fsObj = await sequence.getFrameSize(); } catch (e) {}
    const w = (fsObj && fsObj.width)  || 1920;
    const h = (fsObj && fsObj.height) || 1080;

    const tempPath = String(temp.nativePath || "");
    const home = (os.homedir && os.homedir()) || "";
    const tempFwd = tempPath.replace(/\\/g, "/")
        + (tempPath.endsWith("/") || tempPath.endsWith("\\") ? "" : "/");
    const tempNoSlash = tempFwd.replace(/\/$/, "");
    const tempBack = tempPath
        + (tempPath.endsWith("\\") ? "" : "\\");
    const homeFwd = home.replace(/\\/g, "/") + "/";

    // Each attempt is { label, args }. We call
    // ppro.Exporter.exportSequenceFrame(...args) and record rc.
    const tries = [
        { label: "canon: temp/, .jpg, getFrameSize",
          args: [sequence, tt, "pb-test-1.jpg",  tempFwd,    w, h] },
        { label: "no trailing slash, .jpg",
          args: [sequence, tt, "pb-test-2.jpg",  tempNoSlash, w, h] },
        { label: "windows backslash, .jpg",
          args: [sequence, tt, "pb-test-3.jpg",  tempBack,   w, h] },
        { label: "temp/, .jpeg ext",
          args: [sequence, tt, "pb-test-4.jpeg", tempFwd,    w, h] },
        { label: "temp/, .png ext",
          args: [sequence, tt, "pb-test-5.png",  tempFwd,    w, h] },
        { label: "temp/, .jpg, 1920x1080 hardcoded",
          args: [sequence, tt, "pb-test-6.jpg",  tempFwd,    1920, 1080] },
        { label: "home/, .jpg",
          args: home ? [sequence, tt, "pb-test-7.jpg", homeFwd, w, h] : null },
        { label: "temp/, .jpg, w/h passed as strings",
          args: [sequence, tt, "pb-test-8.jpg",  tempFwd,
                 String(w), String(h)] }
    ];

    const out = [];
    for (const t of tries) {
        if (!t.args) {
            out.push({ label: t.label, skipped: "no home dir" });
            continue;
        }
        let rc, err;
        try { rc = await ppro.Exporter.exportSequenceFrame(...t.args); }
        catch (e) { err = e && (e.message || String(e)); }
        out.push({ label: t.label, rc, err });
    }
    return {
        ok: true,
        sequencePlayerPositionSec: tt && tt.seconds,
        frameSize: fsObj ? { width: fsObj.width, height: fsObj.height,
            keys: Object.keys(fsObj) } : null,
        temp_nativePath: tempPath,
        home,
        attempts: out
    };
}

// Second live probe: do one real export, then attempt readback with
// several URL formats / wait strategies. Reports which combination
// can actually retrieve the bytes Premiere wrote to disk.
async function probeFrameExportReadback() {
    const { sequence } = await getContext();
    if (!sequence) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };
    const uxp = require("uxp");
    const os  = require("os");
    const fs  = uxp.storage.localFileSystem;
    const temp = await fs.getTemporaryFolder();

    let pos;
    try { pos = await sequence.getPlayerPosition(); }
    catch (e) { return { ok: false, error: "NO_PLAYER_POSITION" }; }
    let fsObj = null;
    try { fsObj = await sequence.getFrameSize(); } catch (e) {}
    const w = (fsObj && fsObj.width)  || 1920;
    const h = (fsObj && fsObj.height) || 1080;

    // Native path with trailing backslash (the winning combo from
    // the previous probe). Filename gets a unique suffix.
    let filepath = temp.nativePath;
    const sep = filepath.indexOf("\\") >= 0 ? "\\" : "/";
    if (!filepath.endsWith(sep)) filepath += sep;
    const filename = "pb-readprobe-" + Date.now() + ".jpg";
    const fullNative = filepath + filename;

    // Issue the export.
    let exportRc, exportErr;
    try {
        exportRc = await ppro.Exporter.exportSequenceFrame(
            sequence, pos, filename, filepath, w, h);
    } catch (e) {
        exportErr = e && (e.message || String(e));
    }

    // Wait briefly to let the disk catch up.
    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
    await sleep(250);

    // Build readback attempts.
    const fwdSlash = fullNative.replace(/\\/g, "/");
    const urls = [
        ["file:/// + fwd slashes", "file:///" + fwdSlash.replace(/^\/+/, "")],
        ["file://// + fwd slashes", "file:////" + fwdSlash.replace(/^\/+/, "")],
        ["file:// + native sep",    "file://" + fullNative],
        ["file:/// + native sep",   "file:///" + fullNative]
    ];

    const readAttempts = [];
    for (const [label, url] of urls) {
        let entry, byteLength, err;
        try {
            entry = await fs.getEntryWithUrl(url);
            const buf = await entry.read({ format: uxp.storage.formats.binary });
            byteLength = buf && buf.byteLength;
        } catch (e) {
            err = e && (e.message || String(e));
        }
        readAttempts.push({ label, url, byteLength, err });
    }

    // Also try temp.getEntry(filename) and temp.getEntry with the full path.
    let getEntryFile = null, getEntryFileErr = null;
    try {
        const e2 = await temp.getEntry(filename);
        const buf = await e2.read({ format: uxp.storage.formats.binary });
        getEntryFile = { byteLength: buf && buf.byteLength };
    } catch (e) { getEntryFileErr = e && (e.message || String(e)); }

    return {
        ok: true,
        wrote: { filename, filepath, fullNative,
            exportRc, exportErr },
        readAttempts,
        getEntryByName: getEntryFile,
        getEntryByName_err: getEntryFileErr
    };
}

async function probeExportApis() {
    const { sequence } = await getContext();
    // Function.length is the declared arity - the number of params
    // before any default or rest. Useful to know how many extras
    // exportSequenceFrame wants beyond (sequence, time, path).
    const arities = {};
    if (ppro.Exporter) {
        for (const k of Object.getOwnPropertyNames(ppro.Exporter)) {
            try {
                const v = ppro.Exporter[k];
                if (typeof v === "function") arities["Exporter." + k] = v.length;
            } catch (e) {}
        }
        // Also probe via the prototype - methods may live there.
        const proto = Object.getPrototypeOf(ppro.Exporter);
        if (proto) {
            for (const k of Object.getOwnPropertyNames(proto)) {
                try {
                    const v = ppro.Exporter[k];
                    if (typeof v === "function" && !(k in arities))
                        arities["Exporter." + k + "(proto)"] = v.length;
                } catch (e) {}
            }
        }
    }
    const candidates = sequence
        ? (await probeFrameApis(sequence)).map((c) => c.path) : [];
    // Also dump the function source if Premiere happens to expose it
    // (native bindings usually don't, but worth checking).
    let exporterFnSource = null;
    try {
        if (ppro.Exporter && typeof ppro.Exporter.exportSequenceFrame === "function") {
            exporterFnSource = String(ppro.Exporter.exportSequenceFrame);
        }
    } catch (e) {}
    return {
        cachedWinner: __frameApi,
        probedOnce: __frameApiProbed,
        candidates,
        exporterArities: arities,
        exporterFnSource,
        surface: surfaceReportForExport(sequence)
    };
}

async function exportFramesForV1(opts) {
    const o = opts || {};
    const { sequence } = await getContext();
    if (!sequence) return { ok: false, error: "NO_ACTIVE_SEQUENCE" };

    const track = await sequence.getVideoTrack(0);
    if (!track) return { ok: false, error: "NO_V1_TRACK" };
    const items = await track.getTrackItems(1, false);

    const cap = (typeof o.maxFrames === "number" && o.maxFrames > 0)
        ? o.maxFrames : 12;
    const point = (o.samplePoint === "start") ? "start" : "midpoint";
    const wanted = (o.currentStartSeconds && o.currentStartSeconds.length)
        ? new Set(o.currentStartSeconds.map((n) => Math.round(n * 1000)))
        : null;

    const frames = [];
    const errors = [];
    for (let ci = 0; ci < items.length && frames.length < cap; ci++) {
        const clip = items[ci];
        const s = await clip.getStartTime();
        const e = await clip.getEndTime();
        const sSec = s && s.seconds;
        const eSec = e && e.seconds;
        if (typeof sSec !== "number" || typeof eSec !== "number") continue;
        if (wanted && !wanted.has(Math.round(sSec * 1000))) continue;
        const atSec = (point === "start")
            ? sSec + 0.05
            : sSec + Math.max(0.1, (eSec - sSec) / 2);
        const name = await clip.getName().catch(() => null);
        const r = await exportFrameAt(atSec, {
            maxDim: o.maxDim, width: o.width, height: o.height });
        if (!r.ok) {
            errors.push({ clipIndex: ci, clipName: name, atSec,
                error: r.error, message: r.message });
            continue;
        }
        frames.push({
            clipIndex: ci, clipName: name,
            currentStartSeconds: sSec, endSeconds: eSec,
            atSec: r.atSec, mediaType: r.mediaType,
            base64: r.base64, byteLength: r.byteLength, path: r.path
        });
    }
    return { ok: true, count: frames.length,
        errorCount: errors.length, errors, frames };
}

// ---- LUT generation (.cube format) ----
//
// Bake a set of Lumetri-style params into a 3D LUT and write it as
// a .cube file. The transform chain mirrors Lumetri's own ordering
// reasonably (exposure -> white balance -> tone curves -> contrast
// -> saturation/vibrance) so the look on disk matches what the user
// gets in the Lumetri panel - close enough for portability.
//
// Param ranges (same as set_lumetri_params): Temperature/Tint/
// Contrast/Highlights/Shadows/Whites/Blacks/Vibrance are signed
// -100..+100. Exposure is in stops -5..+5. Saturation is 0..200
// with 100 neutral.

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function applyLumetriTransform(r, g, b, p) {
    // 1) Exposure (stops)
    const expGain = Math.pow(2, (p.Exposure || 0));
    r *= expGain; g *= expGain; b *= expGain;

    // 2) White balance: Temperature warms (R+, B-), Tint shifts G/M
    const t = (p.Temperature || 0) / 100;
    r += t * 0.15;
    b -= t * 0.15;
    const ti = (p.Tint || 0) / 100;
    r += ti * 0.05;
    g -= ti * 0.08;
    b += ti * 0.05;

    // 3) Tone curves: highlights/shadows + whites/blacks
    // Operate on a quick luma to pick the affected region.
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const high = smoothstep(0.5, 1.0, lum)       * (p.Highlights || 0) / 200;
    const shad = smoothstep(0.0, 0.5, 1 - lum)   * (p.Shadows    || 0) / 200;
    const wht  = smoothstep(0.7, 1.0, lum)       * (p.Whites     || 0) / 200;
    const blk  = smoothstep(0.0, 0.3, 1 - lum)   * (p.Blacks     || 0) / 200;
    const delta = high + shad + wht + blk;
    r += delta; g += delta; b += delta;

    // 4) Contrast: S-curve around 0.5
    const c = (p.Contrast || 0) / 100;
    if (c !== 0) {
        const k = 1 + c * 2;
        const tanhK = Math.tanh(k);
        const sc = (x) => Math.tanh(((x - 0.5) * 2) * k) / tanhK * 0.5 + 0.5;
        r = sc(r); g = sc(g); b = sc(b);
    }

    // 5) Saturation around grayscale luma
    const sat = ((p.Saturation == null ? 100 : p.Saturation)) / 100;
    const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = gray + (r - gray) * sat;
    g = gray + (g - gray) * sat;
    b = gray + (b - gray) * sat;

    // 6) Vibrance: boost less-saturated regions more
    const vib = (p.Vibrance || 0) / 100;
    if (vib !== 0) {
        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const cur = maxC > 0 ? (maxC - minC) / maxC : 0;
        const vMul = 1 + vib * (1 - cur);
        const gray2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = gray2 + (r - gray2) * vMul;
        g = gray2 + (g - gray2) * vMul;
        b = gray2 + (b - gray2) * vMul;
    }

    return [clamp01(r), clamp01(g), clamp01(b)];
}

function buildCubeText(title, size, params) {
    const lines = [];
    lines.push("# Generated by PremBot");
    if (title) lines.push("TITLE \"" + title.replace(/"/g, "'") + "\"");
    lines.push("LUT_3D_SIZE " + size);
    lines.push("DOMAIN_MIN 0.0 0.0 0.0");
    lines.push("DOMAIN_MAX 1.0 1.0 1.0");
    lines.push("");
    const step = 1 / (size - 1);
    // .cube order: B outer, G middle, R inner (per Adobe spec).
    for (let bi = 0; bi < size; bi++) {
        const b = bi * step;
        for (let gi = 0; gi < size; gi++) {
            const g = gi * step;
            for (let ri = 0; ri < size; ri++) {
                const r = ri * step;
                const out = applyLumetriTransform(r, g, b, params);
                lines.push(out[0].toFixed(6) + " "
                    + out[1].toFixed(6) + " "
                    + out[2].toFixed(6));
            }
        }
    }
    return lines.join("\n") + "\n";
}

// Sanitize a name for filesystem use - keep ASCII, replace spaces.
function safeName(name) {
    return String(name || "prembot-lut")
        .replace(/[^A-Za-z0-9._-]+/g, "_")
        .slice(0, 80);
}

async function generateLut(opts) {
    const o = opts || {};
    const name = safeName(o.name);
    const title = String(o.title || o.name || name);
    const params = o.params || {};
    const size = (typeof o.size === "number" && o.size >= 9 && o.size <= 65)
        ? o.size : 33;

    const uxp = require("uxp");
    const os  = require("os");
    const fs  = uxp.storage.localFileSystem;

    // Default output dir: <Documents>/PremBot LUTs/
    const home = (os.homedir && os.homedir()) || "";
    let dirPath = o.outputDir || (home
        ? home + (home.indexOf("\\") >= 0 ? "\\" : "/")
            + "Documents" + (home.indexOf("\\") >= 0 ? "\\" : "/")
            + "PremBot LUTs"
        : null);
    if (!dirPath) {
        return { ok: false, error: "NO_OUTPUT_DIR",
            message: "Could not resolve home directory." };
    }
    const sep = dirPath.indexOf("\\") >= 0 ? "\\" : "/";
    if (!dirPath.endsWith(sep)) dirPath += sep;

    // Ensure directory exists. UXP doesn't have an easy
    // createFolderIfMissing on arbitrary paths - we attempt to fetch
    // it, and if it 404s, create the parent's child.
    const dirUrl = "file:///"
        + dirPath.replace(/\\/g, "/").replace(/^\/+/, "");
    let dirEntry = null;
    try { dirEntry = await fs.getEntryWithUrl(dirUrl); } catch (e) {}
    if (!dirEntry) {
        try {
            // Walk up to parent and create the missing leaf.
            const trimmed = dirPath.replace(/[\\/]$/, "");
            const lastSep = Math.max(trimmed.lastIndexOf("\\"),
                trimmed.lastIndexOf("/"));
            const parentPath = trimmed.slice(0, lastSep + 1);
            const leaf = trimmed.slice(lastSep + 1);
            const parentUrl = "file:///"
                + parentPath.replace(/\\/g, "/").replace(/^\/+/, "");
            const parent = await fs.getEntryWithUrl(parentUrl);
            dirEntry = await parent.createFolder(leaf);
        } catch (e) {
            return { ok: false, error: "DIR_CREATE_FAILED",
                message: e && (e.message || String(e)),
                dirPath };
        }
    }

    const fname = name + ".cube";
    const fileEntry = await dirEntry.createFile(fname, { overwrite: true });
    const text = buildCubeText(title, size, params);
    await fileEntry.write(text);

    return {
        ok: true,
        path: dirPath + fname,
        name: fname,
        title,
        size,
        sampleCount: size * size * size,
        params
    };
}

// discover_premiere_capabilities: the discover-before-mutate gate for
// the advanced-capabilities phase (effects, transitions, motion). The
// prembot-capabilities skill documents these as "T1 verified" against
// Premiere UXP 25.6 - but THIS build is 26.2.2, where several factories
// exist-but-throw. So we don't trust the skill's tier tags: we probe
// the live factories here and the liveness flags are the source of
// truth. Building a filter/transition component does NOT mutate the
// timeline, so the createComponent / createVideoTransition probes are
// safe to run. Cached for the session; pass {refresh:true} to re-probe
// (e.g. after a Premiere version change).
let __capsCache = null;

async function discoverPremiereCapabilities(opts) {
    opts = opts || {};
    if (__capsCache && !opts.refresh) {
        return Object.assign({ cached: true }, __capsCache);
    }

    const result = {
        cached: false,
        probedAt: new Date().toISOString(),
        host: {},
        videoEffects: { available: false },
        audioEffects: { available: false },
        videoTransitions: { available: false },
        audioTransitions: { available: false },
        keyframeSurface: {},
        knownGaps: {}
    };

    try {
        const uxp = require("uxp");
        if (uxp.host) {
            result.host.name = uxp.host.name;
            result.host.version = uxp.host.version;
        }
        if (uxp.versions) result.host.uxpVersion = uxp.versions.uxp;
    } catch (e) {
        result.host.error = String((e && e.message) || e);
    }

    // Safe async catalog probe: returns availability + a short sample
    // so the agent can see real match/display names without the full
    // (often 200+ entry) list bloating context.
    async function catalog(fn) {
        try {
            const arr = await fn();
            const isArr = Array.isArray(arr);
            return { available: true,
                count: isArr ? arr.length : 0,
                sample: isArr ? arr.slice(0, 12) : arr };
        } catch (e) {
            return { available: false,
                error: String((e && e.message) || e) };
        }
    }
    function methodsOf(obj) {
        const out = [];
        try {
            for (const k of Object.getOwnPropertyNames(obj)) {
                if (typeof obj[k] === "function") out.push(k);
            }
        } catch (e) {}
        return out;
    }

    // ---- Video effects (VideoFilterFactory) ----
    if (ppro.VideoFilterFactory) {
        const mn = await catalog(() =>
            ppro.VideoFilterFactory.getMatchNames());
        const dn = await catalog(() =>
            ppro.VideoFilterFactory.getDisplayNames());
        result.videoEffects = { available: mn.available,
            matchNames: mn, displayNames: dn,
            factoryMethods: methodsOf(ppro.VideoFilterFactory) };
        // Liveness: build (do NOT append) the first filter. No
        // timeline mutation - this is the 26.2.2 stub test.
        if (mn.available && mn.sample && mn.sample.length) {
            try {
                const c = ppro.VideoFilterFactory
                    .createComponent(mn.sample[0]);
                result.videoEffects.createComponentWorks = !!c;
            } catch (e) {
                result.videoEffects.createComponentWorks = false;
                result.videoEffects.createComponentError =
                    String((e && e.message) || e);
            }
        }
    } else {
        result.videoEffects.error = "ppro.VideoFilterFactory missing";
    }

    // ---- Audio effects (AudioFilterFactory) ----
    if (ppro.AudioFilterFactory) {
        const methods = methodsOf(ppro.AudioFilterFactory);
        let dn = { available: false,
            note: "no getDisplayNames on this build" };
        if (typeof ppro.AudioFilterFactory.getDisplayNames
                === "function") {
            dn = await catalog(() =>
                ppro.AudioFilterFactory.getDisplayNames());
        }
        result.audioEffects = { available: dn.available,
            displayNames: dn, factoryMethods: methods };
    } else {
        result.audioEffects.error = "ppro.AudioFilterFactory missing";
    }

    // ---- Video transitions (TransitionFactory) ----
    if (ppro.TransitionFactory) {
        const tMethods = methodsOf(ppro.TransitionFactory);
        const mn = await catalog(() =>
            ppro.TransitionFactory.getVideoTransitionMatchNames());
        result.videoTransitions = { available: mn.available,
            matchNames: mn, factoryMethods: tMethods };
        if (mn.available && mn.sample && mn.sample.length) {
            try {
                const t = ppro.TransitionFactory
                    .createVideoTransition(mn.sample[0]);
                result.videoTransitions.createWorks = !!t;
            } catch (e) {
                result.videoTransitions.createWorks = false;
                result.videoTransitions.createError =
                    String((e && e.message) || e);
            }
        }
        const hasAudioTx = tMethods.indexOf(
            "getAudioTransitionMatchNames") !== -1;
        result.audioTransitions = { available: hasAudioTx,
            note: hasAudioTx
                ? "factory method present - probe before trusting"
                : "not surfaced - use add_audio_fade pairs" };
    } else {
        result.videoTransitions.error =
            "ppro.TransitionFactory missing";
    }

    // ---- Keyframe / motion surface ----
    try {
        const im = ppro.Constants && ppro.Constants.InterpolationMode;
        result.keyframeSurface.interpolationModes = im
            ? Object.keys(im) : null;
    } catch (e) {
        result.keyframeSurface.interpError =
            String((e && e.message) || e);
    }
    // Probe VideoClipTrackItem prototype for the action factories the
    // skill's motion/transition patterns require on THIS build.
    try {
        const proto = ppro.VideoClipTrackItem
            && ppro.VideoClipTrackItem.prototype;
        const want = ["createAddVideoTransitionAction",
            "createRemoveVideoTransitionAction", "getComponentChain",
            "getInPoint", "getStartTime", "getSpeed",
            "isSpeedReversed"];
        const present = {};
        if (proto) {
            for (const w of want) {
                present[w] = typeof proto[w] === "function";
            }
        }
        result.keyframeSurface.videoClipTrackItem = present;
    } catch (e) {
        result.keyframeSurface.vctiError =
            String((e && e.message) || e);
    }

    result.knownGaps = {
        speedControl: "no UXP createSetSpeedAction in skill's "
            + "11/10/2025 docs - route via CEP helper if needed",
        pointKeyframes: "Position/AnchorPoint use PointKeyframe - "
            + "may not write reliably; probe before shipping motion",
        skillBaseline: "prembot-capabilities skill written vs UXP "
            + "25.6; this host reports "
            + (result.host.version || "unknown")
            + " - trust the liveness flags above, not the skill's "
            + "tier tags"
    };

    __capsCache = result;
    return result;
}

// ---- Transitions (Phase B1) -----------------------------------------
//
// UXP T1 path, probed live on 26.2.2 (discover_premiere_capabilities:
// TransitionFactory + createAddVideoTransitionAction both present, 152
// transitions). Two skill (prembot-capabilities v0.2) constraints are
// load-bearing here:
//
//   1. MATCH-NAME DISCOVERY IS MANDATORY. Transition match names ship
//      WITHOUT the PR./AE. prefix on this build ("ADBE Cross Dissolve",
//      not "PR.ADBE Cross Dissolve") - the opposite of video effects.
//      Never accept a hardcoded match name; resolve every request
//      against the live getVideoTransitionMatchNames() catalog.
//   2. THE HANDLE PROBLEM. A two-sided dissolve needs source frames
//      beyond the trimmed in/out to render the overlap. Clips trimmed
//      tight (the arrangement engine does this) have no handle and the
//      transition silently degrades or fails. We measure handles and
//      report exactly what landed so callers (esp. the Phase B2
//      energy-aware post-pass) can reason about it.
//
// B1 is the mechanism + honest measurement. The tiered energy-aware
// policy that USES this lives in Phase B2 (applyArrangement post-pass).

let __transitionCatalog = null;

async function getTransitionCatalog(refresh) {
    if (__transitionCatalog && !refresh) return __transitionCatalog;
    if (!ppro.TransitionFactory
            || typeof ppro.TransitionFactory.getVideoTransitionMatchNames
                !== "function") {
        throw new Error("TransitionFactory.getVideoTransitionMatchNames "
            + "unavailable on this build");
    }
    const names = await ppro.TransitionFactory
        .getVideoTransitionMatchNames();
    __transitionCatalog = Array.isArray(names) ? names : [];
    return __transitionCatalog;
}

// Resolve a user-friendly query ("cross dissolve", "dip to black")
// to a live match name. Exact match wins; then case-insensitive
// substring; then token-overlap. Throws with closest candidates so
// the agent can correct itself - never silently picks a wrong one.
function resolveTransitionMatchName(catalog, query) {
    if (!query) throw new Error("transition query required");
    const q = String(query).trim().toLowerCase();
    const exact = catalog.find((n) => n.toLowerCase() === q);
    if (exact) return { matchName: exact, how: "exact" };
    const sub = catalog.filter((n) => n.toLowerCase().indexOf(q) !== -1);
    if (sub.length === 1) return { matchName: sub[0], how: "substring" };
    if (sub.length > 1) {
        // Prefer the shortest (least-qualified) match, e.g. "ADBE
        // Cross Dissolve" over "ADBE Cross Zoom" for query "cross".
        sub.sort((a, b) => a.length - b.length);
        return { matchName: sub[0], how: "substring_multi",
            alternatives: sub.slice(0, 6) };
    }
    const qTokens = q.split(/\s+/).filter(Boolean);
    const scored = catalog.map((n) => {
        const ln = n.toLowerCase();
        let s = 0;
        for (const t of qTokens) if (ln.indexOf(t) !== -1) s++;
        return { n, s };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored.length) {
        return { matchName: scored[0].n, how: "token",
            alternatives: scored.slice(0, 6).map((x) => x.n) };
    }
    const e = new Error("No transition matches \"" + query
        + "\" on this build");
    e.closest = catalog.slice(0, 10);
    throw e;
}

// Handle = source media available beyond the trimmed edges. Two-sided
// transitions need >= duration/2 on each adjoining side. Per skill
// v0.2 "The handle problem".
//
// The skill's documented formula (projectItem.getInPoint(MediaType.
// VIDEO)) is WRONG on 26.2.2 - the raw ProjectItem has no getInPoint.
// PremBot's own pattern (index.js queryCast usage) says: cast to
// ClipProjectItem first. We don't yet know the exact 26.2.2 source-
// duration method, so this probes candidates in priority order and,
// on total failure, returns the cast object's method names in the
// note so the NEXT live run reveals the real API (PremBot's self-
// diagnosing pattern) instead of us guessing a third time. Zero
// handles always forces the safe single-sided path.
async function getHandlesFor(clip) {
    try {
        const tIn  = await clip.getInPoint().catch(() => null);
        const tOut = await clip.getOutPoint().catch(() => null);
        const tInS  = tIn  && typeof tIn.seconds  === "number"
            ? tIn.seconds  : null;
        const tOutS = tOut && typeof tOut.seconds === "number"
            ? tOut.seconds : null;

        let pItem = await clip.getProjectItem();
        if (!pItem) return { leadSec: 0, tailSec: 0,
            note: "no projectItem - zero handle" };
        let castMethod = "none";
        if (ppro.ClipProjectItem
            && typeof ppro.ClipProjectItem.queryCast === "function") {
            const c = ppro.ClipProjectItem.queryCast(pItem);
            if (c) { pItem = c; castMethod = "queryCast"; }
        }

        // The 26.2.2 self-diagnosing run revealed ClipProjectItem's
        // real surface: plain getInPoint()/getOutPoint() with NO
        // MediaType argument (the arg is what silently broke the
        // skill's documented formula). These return the bin clip's
        // source bounds; for a clip never sub-clipped in the bin
        // they ARE the full media extent. Handle = the room between
        // the bin bounds and the trackitem's tighter trim:
        //   lead = trackIn  - binIn
        //   tail = binOut    - trackOut
        const readSec = async (fn) => {
            try {
                const v = await fn();
                if (v && typeof v.seconds === "number") return v.seconds;
                if (typeof v === "number") return v;
            } catch (e) { /* method shape differs - fall through */ }
            return null;
        };
        let binInS  = await readSec(() => pItem.getInPoint());
        let binOutS = await readSec(() => pItem.getOutPoint());
        let via = "getInPoint/getOutPoint";

        // Fallback: derive media end from getMedia() duration if the
        // bin out-point wasn't usable.
        if (binOutS == null) {
            const media = await (async () => {
                try { return await pItem.getMedia(); }
                catch (e) { return null; }
            })();
            if (media) {
                const md = await readSec(() => media.getDuration());
                if (md != null) {
                    binInS  = binInS != null ? binInS : 0;
                    binOutS = md;
                    via = "getMedia().getDuration";
                }
            }
        }

        if (binInS != null && binOutS != null
                && tInS != null && tOutS != null) {
            return {
                leadSec: Math.max(0, +(tInS - binInS).toFixed(3)),
                tailSec: Math.max(0, +(binOutS - tOutS).toFixed(3)),
                via, castMethod
            };
        }

        // Couldn't get media duration - enumerate what IS available
        // so the next run tells us the real API.
        let methods = [];
        try {
            let o = pItem;
            const seen = {};
            while (o && o !== Object.prototype) {
                for (const k of Object.getOwnPropertyNames(o)) {
                    if (!seen[k] && typeof pItem[k] === "function"
                        && k !== "constructor") {
                        seen[k] = 1; methods.push(k);
                    }
                }
                o = Object.getPrototypeOf(o);
            }
        } catch (e) { /* enumeration best-effort */ }
        return { leadSec: 0, tailSec: 0,
            note: "media duration unresolved (cast=" + castMethod
                + ", tIn=" + tInS + ", tOut=" + tOutS
                + ") - zero handle. ClipProjectItem methods: "
                + methods.sort().join(",") };
    } catch (e) {
        return { leadSec: 0, tailSec: 0,
            note: "handle probe failed (" + ((e && e.message) || e)
                + ") - zero handle" };
    }
}

const TRANSITION_ALIGN = { center: 0, startAtCut: 1, endAtCut: 2 };

async function addTransition(o) {
    o = o || {};
    const { sequence } = await getContext();
    const trackIndex = o.trackIndex || 0;
    const position   = o.position === "start" ? "start" : "end";
    const durationSec = o.durationSec > 0 ? o.durationSec : 1.0;
    const alignKey   = o.alignment in TRANSITION_ALIGN
        ? o.alignment : "center";
    const autoDegrade = o.autoDegrade !== false;

    const catalog = await getTransitionCatalog(o.refreshCatalog);
    const resolved = resolveTransitionMatchName(catalog,
        o.matchName || o.query);

    const { clip } = await findVideoClipByStart(
        sequence, trackIndex, o.currentStartSeconds);

    const handles = await getHandlesFor(clip);
    // The handle that matters is on the side the transition sits.
    // position "end" -> uses the clip's TAIL; "start" -> its LEAD.
    const sideHandle = position === "end"
        ? handles.tailSec : handles.leadSec;
    const needSec = durationSec / 2;

    let forceSingleSided = !!o.forceSingleSided;
    let applied = forceSingleSided ? "single_sided" : "two_sided";
    let reason;
    if (!forceSingleSided && sideHandle < needSec) {
        if (autoDegrade) {
            forceSingleSided = true;
            applied = "single_sided_degraded";
            reason = "side_handle_" + sideHandle + "s_need_"
                + needSec + "s";
        } else {
            applied = "two_sided_no_handle";
            reason = "side_handle_" + sideHandle + "s_need_"
                + needSec + "s (autoDegrade off - transition may "
                + "fail or silently single-side)";
        }
    }

    let opts;
    try {
        opts = new ppro.AddTransitionOptions();
        if (typeof opts.setApplyToStart === "function")
            opts.setApplyToStart(position === "start");
        if (typeof opts.setDuration === "function")
            opts.setDuration(
                await ppro.TickTime.createWithSeconds(durationSec));
        if (typeof opts.setForceSingleSided === "function")
            opts.setForceSingleSided(forceSingleSided);
        if (typeof opts.setTransitionAlignment === "function")
            opts.setTransitionAlignment(TRANSITION_ALIGN[alignKey]);
    } catch (e) {
        return { ok: false, error: "OPTIONS_BUILD_FAILED",
            message: (e && e.message) || String(e),
            hint: "AddTransitionOptions constructor/setters differ "
                + "from skill v0.2 on this build - probe the shape" };
    }

    let transition;
    try {
        transition = ppro.TransitionFactory
            .createVideoTransition(resolved.matchName);
    } catch (e) {
        return { ok: false, error: "CREATE_TRANSITION_FAILED",
            matchName: resolved.matchName,
            message: (e && e.message) || String(e) };
    }

    try {
        await dispatch(
            (await ppro.Project.getActiveProject()),
            clip.createAddVideoTransitionAction(transition, opts),
            "PremBot: add transition " + resolved.matchName);
    } catch (e) {
        return { ok: false, error: "ADD_TRANSITION_FAILED",
            matchName: resolved.matchName, position, applied,
            message: (e && e.message) || String(e),
            hint: "createAddVideoTransitionAction dispatch failed - "
                + "this is the 26.2.2 unknown B1 exists to settle" };
    }

    return {
        ok: true,
        matchName: resolved.matchName,
        resolvedHow: resolved.how,
        alternatives: resolved.alternatives,
        position, durationSec,
        applied,
        requested: o.forceSingleSided ? "single_sided" : "two_sided",
        reason,
        handles,
        // When a two-sided dissolve degrades because BOTH the clip
        // and its neighbour are placed whole (zero handle), a cross-
        // dissolve physically cannot render at this cut - the
        // degraded single-sided eats into the neighbour instead,
        // which looks like "nothing on clip A, a fade on clip B".
        // A generated transition (dip to black) needs no handle and
        // renders correctly at clip A's own edge. Surface that so
        // the agent can offer it instead of silently degrading.
        advice: (applied === "single_sided_degraded"
                 && sideHandle <= 0)
            ? "zero handle on the " + position + " side: a true "
              + "cross-dissolve cannot render here. A handle-free "
              + "generated transition (query 'dip to black', or "
              + "forceSingleSided:true) renders correctly at this "
              + "edge. To get a real dissolve, the clip must be "
              + "trimmed back from a longer source (the arrangement "
              + "engine does this; a whole-placed clip never can)."
            : undefined,
        alignmentUsed: alignKey,
        alignmentNote: "alignment enum (center/startAtCut/endAtCut) "
            + "is UNVERIFIED per skill v0.2 - confirm visually"
    };
}

async function removeTransition(o) {
    o = o || {};
    const { sequence } = await getContext();
    const { clip } = await findVideoClipByStart(
        sequence, o.trackIndex || 0, o.currentStartSeconds);
    const TP = ppro.Constants && ppro.Constants.TransitionPosition;
    const pos = (o.position === "start")
        ? (TP && TP.START) : (TP && TP.END);
    try {
        await dispatch(
            (await ppro.Project.getActiveProject()),
            clip.createRemoveVideoTransitionAction(pos),
            "PremBot: remove transition");
        return { ok: true, position: o.position || "end" };
    } catch (e) {
        return { ok: false, error: "REMOVE_TRANSITION_FAILED",
            message: (e && e.message) || String(e) };
    }
}

async function listTransitions(o) {
    o = o || {};
    const catalog = await getTransitionCatalog(o.refresh);
    return { ok: true, count: catalog.length,
        matchNames: catalog };
}

globalThis.PremBotPrimitives = {
    ping: () => ping(),
    discover_premiere_capabilities: (opts) =>
        discoverPremiereCapabilities(opts || {}),
    list_transitions: (o) => listTransitions(o || {}),
    add_transition: (o) => addTransition(o || {}),
    remove_transition: (o) => removeTransition(o || {}),
    export_frame_at: ({ atSec, maxDim, width, height }) =>
        exportFrameAt(atSec, { maxDim, width, height }),
    export_frames_for_v1: (opts) => exportFramesForV1(opts || {}),
    probe_export_apis: () => probeExportApis(),
    probe_frame_export_live: () => probeFrameExportLive(),
    probe_frame_export_readback: () => probeFrameExportReadback(),
    generate_lut: (opts) => generateLut(opts || {}),
    list_project_clips: () => listProjectClips(),
    list_timeline_clips: () => listSequenceClips(),
    move_clips: ({ trackIndex, moves }) => moveClipsBatch(trackIndex, moves),
    clone_clip_to_time: ({ srcTrackIndex, srcCurrentStartSeconds,
                           targetStartSeconds }) =>
        cloneClipToTime(srcTrackIndex, srcCurrentStartSeconds, targetStartSeconds),
    set_clip_disabled: ({ trackIndex, currentStartSeconds, disabled }) =>
        setClipDisabled(trackIndex, currentStartSeconds, disabled),
    remove_clips: ({ trackIndex, currentStartSeconds, ripple }) =>
        removeClips(trackIndex, currentStartSeconds, ripple),
    reorder_track: ({ trackIndex, newOrder }) =>
        reorderTrack(trackIndex, newOrder),
    find_v1_clips_matching: ({ query }) =>
        findV1ClipsMatching(query),
    find_word_positions_in_v1: ({ words }) =>
        findWordPositionsInV1(words),
    add_markers_for_words: ({ words }) =>
        addMarkersForWords(words)
};

entrypoints.setup({
    panels: {
        primary: {
            create(rootNode) { attach(document); },
            show() {}, hide() {}, destroy() {}
        }
    }
});
