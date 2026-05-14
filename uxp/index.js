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
            out.push({ name: item.name });
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

globalThis.PremBotPrimitives = {
    ping: () => ping(),
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
        reorderTrack(trackIndex, newOrder)
};

entrypoints.setup({
    panels: {
        primary: {
            create(rootNode) { attach(document); },
            show() {}, hide() {}, destroy() {}
        }
    }
});
