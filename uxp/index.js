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

async function moveClip(trackIndex, clipIndex, newStartSeconds) {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(trackIndex);
    const items = await track.getTrackItems(1, false);
    const clip = items[clipIndex];
    if (!clip) throw new Error("No clip at V" + (trackIndex + 1)
        + " index " + clipIndex);
    const newStart = await ppro.TickTime.createWithSeconds(newStartSeconds);
    const action = await clip.createMoveAction(newStart);
    await dispatch(project, action,
        "PremBot: move V" + (trackIndex + 1) + " clip " + clipIndex
        + " to " + newStartSeconds + "s");
    return { ok: true, trackIndex, clipIndex, newStartSeconds };
}

async function setClipDisabled(trackIndex, clipIndex, disabled) {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(trackIndex);
    const items = await track.getTrackItems(1, false);
    const clip = items[clipIndex];
    if (!clip) throw new Error("No clip at V" + (trackIndex + 1)
        + " index " + clipIndex);
    const action = await clip.createSetDisabledAction(!!disabled);
    await dispatch(project, action,
        "PremBot: " + (disabled ? "disable" : "enable")
        + " V" + (trackIndex + 1) + " clip " + clipIndex);
    return { ok: true, trackIndex, clipIndex, disabled: !!disabled };
}

async function cloneClipToTime(srcTrackIndex, srcClipIndex, targetStartSeconds) {
    const { project, sequence, editor } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    if (!editor)   throw new Error("Could not get SequenceEditor");
    const track = await sequence.getVideoTrack(srcTrackIndex);
    const items = await track.getTrackItems(1, false);
    const src = items[srcClipIndex];
    if (!src) throw new Error("No clip at V" + (srcTrackIndex + 1)
        + " index " + srcClipIndex);
    // Clone uses an OFFSET, not an absolute target. Translate.
    const srcStartT = await src.getStartTime();
    const srcStartSec = (srcStartT && srcStartT.seconds) || 0;
    const offsetSec = targetStartSeconds - srcStartSec;
    const offset = await ppro.TickTime.createWithSeconds(offsetSec);
    const action = await editor.createCloneTrackItemAction(
        src, offset, /* vVertOff */ 0, /* aVertOff */ 0,
        /* alignToVideo */ true, /* isInsert */ true);
    await dispatch(project, action,
        "PremBot: clone V" + (srcTrackIndex + 1) + " clip " + srcClipIndex
        + " to " + targetStartSeconds + "s");
    return { ok: true, srcTrackIndex, srcClipIndex, targetStartSeconds, offsetSec };
}

async function removeClips(trackIndex, clipIndices) {
    const { project, sequence, editor } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    if (!editor)   throw new Error("Could not get SequenceEditor");
    const track = await sequence.getVideoTrack(trackIndex);
    const items = await track.getTrackItems(1, false);
    const targets = clipIndices.map((i) => items[i]).filter(Boolean);
    if (targets.length === 0) {
        return { ok: true, removed: 0, note: "No matching clips" };
    }
    const sel = await sequence.getSelection();
    if (typeof sequence.clearSelection === "function") {
        try { await sequence.clearSelection(); } catch (e) {}
    }
    for (const it of targets) {
        try { await sel.addItem(it); } catch (e) {}
    }
    const action = await editor.createRemoveItemsAction(sel, false, null);
    await dispatch(project, action,
        "PremBot: remove " + targets.length + " clip(s) from V"
        + (trackIndex + 1));
    return { ok: true, removed: targets.length, trackIndex, clipIndices };
}

async function clearV1() {
    const { sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);
    if (items.length === 0) return { ok: true, cleared: 0 };
    return removeClips(0, items.map((_, i) => i));
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

    bind(root, "btn-move",      "move V1 clip 0 -> 5s", () => moveClip(0, 0, 5));
    bind(root, "btn-clone",     "clone V1 clip 0 -> end of V1",
        async () => {
            const { sequence } = await getContext();
            const t = await sequence.getVideoTrack(0);
            const items = await t.getTrackItems(1, false);
            const last = items[items.length - 1];
            const lastEnd = last ? await last.getEndTime() : null;
            const target = (lastEnd && lastEnd.seconds) || 0;
            return cloneClipToTime(0, 0, target);
        });
    bind(root, "btn-disable",   "toggle disable V1 clip 0",
        async () => {
            const { sequence } = await getContext();
            const t = await sequence.getVideoTrack(0);
            const items = await t.getTrackItems(1, false);
            const cur = items[0] && await items[0].isDisabled();
            return setClipDisabled(0, 0, !cur);
        });
    bind(root, "btn-clear-v1",  "clearV1",             clearV1);

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
    move_clip: ({ trackIndex, clipIndex, newStartSeconds }) =>
        moveClip(trackIndex, clipIndex, newStartSeconds),
    clone_clip_to_time: ({ srcTrackIndex, srcClipIndex, targetStartSeconds }) =>
        cloneClipToTime(srcTrackIndex, srcClipIndex, targetStartSeconds),
    set_clip_disabled: ({ trackIndex, clipIndex, disabled }) =>
        setClipDisabled(trackIndex, clipIndex, disabled),
    remove_clips: ({ trackIndex, clipIndices }) =>
        removeClips(trackIndex, clipIndices)
};

entrypoints.setup({
    panels: {
        primary: {
            create(rootNode) { attach(document); },
            show() {}, hide() {}, destroy() {}
        }
    }
});
