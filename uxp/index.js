// PremBot UXP entry. Uses the canonical entrypoints.setup() pattern and
// the documented premierepro DOM API (lockedAccess + executeTransaction
// for mutations, async getters for cross-boundary fetches).

const { entrypoints } = require("uxp");
const ppro = require("premierepro");

// ---- Bridge: thin wrappers around the premierepro module ----

async function getContext() {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("No project open");
    const sequence = await project.getActiveSequence();
    const editor = sequence ? await ppro.SequenceEditor.getEditor(sequence) : null;
    return { project, sequence, editor };
}

async function ping() {
    const { project, sequence } = await getContext();
    let seqInfo = null;
    if (sequence) {
        const vCount = await sequence.getVideoTrackCount();
        const aCount = await sequence.getAudioTrackCount();
        seqInfo = {
            name: sequence.name,
            videoTracks: vCount,
            audioTracks: aCount
        };
    }
    return {
        project: { name: project.name, path: project.path },
        activeSequence: seqInfo
    };
}

// Walk the project bin tree recursively, returning clip items.
async function walkProjectItems(parent, out) {
    const items = await parent.getItems();
    for (const item of items) {
        const isFolder = (ppro.FolderItem && item instanceof ppro.FolderItem)
            || typeof item.getItems === "function";
        const isClip = (ppro.ClipProjectItem && item instanceof ppro.ClipProjectItem);
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
            // 1 = clip items, 2 = transitions, false = skip empty slots.
            const items = await track.getTrackItems(1, false);
            for (let ci = 0; ci < items.length; ci++) {
                const clip = items[ci];
                let inSec = null, outSec = null, startSec = null, endSec = null, name = null;
                try {
                    const inT = await clip.getInPoint();
                    if (inT && typeof inT.seconds === "number") inSec = inT.seconds;
                } catch (e) {}
                try {
                    const outT = await clip.getOutPoint();
                    if (outT && typeof outT.seconds === "number") outSec = outT.seconds;
                } catch (e) {}
                try {
                    const sT = await clip.getStartTime();
                    if (sT && typeof sT.seconds === "number") startSec = sT.seconds;
                } catch (e) {}
                try {
                    const eT = await clip.getEndTime();
                    if (eT && typeof eT.seconds === "number") endSec = eT.seconds;
                } catch (e) {}
                try { name = await clip.getName(); } catch (e) {}
                out[kind].push({
                    trackIndex: ti, clipIndex: ci, name,
                    startSeconds: startSec, endSeconds: endSec,
                    inSeconds: inSec, outSeconds: outSec
                });
            }
        }
    }
    await dump(sequence.getVideoTrack, vCount, "video");
    await dump(sequence.getAudioTrack, aCount, "audio");
    return out;
}

// ---- Probe: enumerate create*/* factory methods on live objects ----

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
        projectCreate: listMethods(project, "create"),
        projectMethods: listMethods(project, ""),
        sequenceCreate: sequence ? listMethods(sequence, "create") : null,
        editorCreate:   editor ? listMethods(editor, "create") : null,
        editorMethods:  editor ? listMethods(editor, "") : null,
        SequenceEditorStaticKeys: ppro.SequenceEditor
            ? Object.getOwnPropertyNames(ppro.SequenceEditor) : null,
    };
    if (sequence) {
        const vCount = await sequence.getVideoTrackCount();
        if (vCount > 0) {
            const track = await sequence.getVideoTrack(0);
            report.trackCreate = listMethods(track, "create");
            report.trackMethods = listMethods(track, "");
            const items = await track.getTrackItems(1, false);
            if (items && items.length > 0) {
                const ti = items[0];
                report.trackItemCreate = listMethods(ti, "create");
                report.trackItemMethods = listMethods(ti, "");
            }
        }
        // Selection objects often expose remove/delete actions.
        try {
            const sel = await sequence.getSelection();
            report.selectionMethods = sel ? listMethods(sel, "") : null;
        } catch (e) { report.selectionError = String(e); }
    }
    const root = await project.getRootItem();
    const projItems = await root.getItems();
    if (projItems && projItems.length > 0) {
        report.projectItemCreate = listMethods(projItems[0], "create");
        report.projectItemMethods = listMethods(projItems[0], "");
    }
    return report;
}

// ---- Mutations ----
//
// All mutations follow the canonical pattern:
//   project.lockedAccess(() => {
//     project.executeTransaction((c) => c.addAction(action), "Undo label");
//   });
// Action factories are awaited (some are async). TickTime values must be
// real ppro.TickTime objects, never raw seconds.

async function trimFirstClipOutMinusOneSec() {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(0);
    const clips = await track.getTrackItems(1, false);
    if (clips.length === 0) throw new Error("No clips on V1");

    const clip = clips[0];
    const endT = await clip.getEndTime();
    const startT = await clip.getStartTime();
    const inT  = await clip.getInPoint();
    const outT = await clip.getOutPoint();
    const endSec   = endT && endT.seconds;
    const startSec = startT && startT.seconds;
    const inSec    = inT && inT.seconds;
    const outSec   = outT && outT.seconds;
    const name = await clip.getName().catch(() => null);

    if (typeof endSec !== "number") {
        throw new Error("Could not read endTime.seconds; got " + endT);
    }
    const newEndSec = endSec - 1;
    const newOutSec = (typeof outSec === "number") ? outSec - 1 : null;
    const newEnd = await ppro.TickTime.createWithSeconds(newEndSec);
    const newOut = (newOutSec !== null && newOutSec > 0)
        ? await ppro.TickTime.createWithSeconds(newOutSec) : null;

    // Try multiple primitives and capture every failure. Whichever takes
    // first wins; otherwise we report all the errors so we know where we
    // stand.
    const attempts = [];
    const tries = [
        ["clip.createSetEndAction(newEnd)",
            () => clip.createSetEndAction(newEnd),
            { argLen: clip.createSetEndAction.length }],
        ["clip.createSetEndAction(newEnd, false)",
            () => clip.createSetEndAction(newEnd, false), {}],
        ["clip.createSetEndAction(newEnd, true)",
            () => clip.createSetEndAction(newEnd, true), {}],
        ["clip.createSetOutPointAction(newOut)",
            () => newOut && clip.createSetOutPointAction(newOut),
            { argLen: clip.createSetOutPointAction.length }],
    ];

    for (const [label, build, meta] of tries) {
        try {
            const action = await build();
            if (!action) {
                attempts.push({ tried: label, skipped: "factory returned null" });
                continue;
            }
            try {
                project.lockedAccess(() => {
                    project.executeTransaction((c) => c.addAction(action),
                        "PremBot: trim V1 clip 0");
                });
            } catch (txErr) {
                attempts.push({ tried: label, txError: txErr.message || String(txErr) });
                continue;
            }
            return Object.assign({
                ok: true, used: label,
                clip: name,
                before: { startSec, endSec, inSec, outSec },
                attempts
            }, meta);
        } catch (e) {
            attempts.push(Object.assign({ tried: label,
                factoryError: e.message || String(e) }, meta));
        }
    }
    throw new Error("All trim attempts failed: " + JSON.stringify(attempts, null, 2));
}

async function insertFirstBinClipAtZero() {
    const { project, sequence, editor } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    if (!editor)   throw new Error("Could not get SequenceEditor");

    const root = await project.getRootItem();
    const items = await root.getItems();
    const firstClip = items.find(
        (it) => !(ppro.FolderItem && it instanceof ppro.FolderItem)
                && typeof it.getItems !== "function"
    );
    if (!firstClip) throw new Error("No clips in project bin root");

    // Insert AFTER the last clip on V1 so we don't overlap an existing
    // item at time 0 (insert-with-limitShift=false rejects overlap).
    const v1 = await sequence.getVideoTrack(0);
    const v1Items = await v1.getTrackItems(1, false);
    let insertSec = 0;
    if (v1Items.length > 0) {
        const lastEnd = await v1Items[v1Items.length - 1].getEndTime();
        if (lastEnd && typeof lastEnd.seconds === "number") {
            insertSec = lastEnd.seconds;
        }
    }
    const insertAt = await ppro.TickTime.createWithSeconds(insertSec);
    const firstClipName = (typeof firstClip.getName === "function")
        ? await firstClip.getName().catch(() => "(unnamed)")
        : "(no getName)";

    const ctx = {
        projectItem: firstClipName,
        atSeconds: insertAt && insertAt.seconds,
        editorHasFactory: typeof editor.createInsertProjectItemAction === "function",
        insertArgLen:    editor.createInsertProjectItemAction.length,
        overwriteArgLen: editor.createOverwriteItemAction.length,
        addItemArgLen:   editor.createAddItemAction
            ? editor.createAddItemAction.length : null,
    };

    const tries = [
        ["editor.createInsertProjectItemAction(item,t,0,0,false)",
            () => editor.createInsertProjectItemAction(firstClip, insertAt, 0, 0, false)],
        ["editor.createInsertProjectItemAction(item,t,0,0,true)",
            () => editor.createInsertProjectItemAction(firstClip, insertAt, 0, 0, true)],
        ["editor.createInsertProjectItemAction(item,t,1,1,false)",
            () => editor.createInsertProjectItemAction(firstClip, insertAt, 1, 1, false)],
        ["editor.createOverwriteItemAction(item,t,0,0)",
            () => editor.createOverwriteItemAction(firstClip, insertAt, 0, 0)],
        ["editor.createOverwriteItemAction(item,t,1,1)",
            () => editor.createOverwriteItemAction(firstClip, insertAt, 1, 1)],
        ["editor.createAddItemAction(item,t)",
            () => editor.createAddItemAction && editor.createAddItemAction(firstClip, insertAt)],
    ];

    const attempts = [];
    for (const [label, build] of tries) {
        try {
            const action = await build();
            if (!action) {
                attempts.push({ tried: label, skipped: "factory missing or null" });
                continue;
            }
            try {
                project.lockedAccess(() => {
                    project.executeTransaction((c) => c.addAction(action),
                        "PremBot: insert " + firstClipName);
                });
            } catch (txErr) {
                attempts.push({ tried: label, txError: txErr.message || String(txErr) });
                continue;
            }
            return Object.assign({ ok: true, used: label }, ctx, { attempts });
        } catch (e) {
            attempts.push({ tried: label, factoryError: e.message || String(e) });
        }
    }
    throw new Error("All insert attempts failed: ctx=" + JSON.stringify(ctx)
        + " attempts=" + JSON.stringify(attempts, null, 2));
}

// Remove all clips from V1 via editor.createRemoveItemsAction (confirmed
// present on the SequenceEditor in this build). Exact arg shape is not
// documented in the skill, so we try a couple of likely signatures.

async function clearV1() {
    const { project, sequence, editor } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    if (!editor)   throw new Error("Could not get SequenceEditor");
    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);
    if (!items || items.length === 0) {
        return { cleared: 0, note: "V1 already empty" };
    }

    const ctx = {
        argLen: editor.createRemoveItemsAction.length,
        itemCount: items.length,
        hasTrackItemSelectionCtor: typeof ppro.TrackItemSelection === "function",
        sequenceSelectionType: null
    };

    // The "Illegal Parameter type" errors with the right arg count strongly
    // suggest the factory wants a TrackItemSelection-style object, not a
    // plain Array. Try the live sequence selection and a fresh constructed
    // one, plus the raw-array fallback in case a future build accepts both.

    async function buildSelectionVariants() {
        const variants = [];

        // 1) Reuse the sequence's selection, clear it, then add ours.
        try {
            const sel = await sequence.getSelection();
            ctx.sequenceSelectionType = sel ? sel.constructor && sel.constructor.name : null;
            if (sel) {
                try {
                    // Best-effort: remove anything already in it.
                    const existing = await sel.getTrackItems().catch(() => []);
                    for (const it of (existing || [])) {
                        try { await sel.removeItem(it); } catch (e) {}
                    }
                } catch (e) {}
                for (const it of items) {
                    try { await sel.addItem(it); } catch (e) {}
                }
                variants.push(["sequence.getSelection() seeded", sel]);
            }
        } catch (e) {
            ctx.getSelectionError = e.message || String(e);
        }

        // 2) Fresh TrackItemSelection if the constructor is exposed.
        try {
            if (typeof ppro.TrackItemSelection === "function") {
                const sel = new ppro.TrackItemSelection();
                for (const it of items) {
                    try { await sel.addItem(it); } catch (e) {}
                }
                variants.push(["new ppro.TrackItemSelection()", sel]);
            }
        } catch (e) {
            ctx.newTrackItemSelectionError = e.message || String(e);
        }

        // 3) Raw array fallback.
        variants.push(["plain Array of items", items]);
        return variants;
    }

    const selections = await buildSelectionVariants();
    const argShapes = [
        ["(sel, false, false)", (sel) => [sel, false, false]],
        ["(sel, true, false)",  (sel) => [sel, true, false]],
        ["(sel, false)",        (sel) => [sel, false]],
        ["(sel, true)",         (sel) => [sel, true]],
        ["(sel)",               (sel) => [sel]],
    ];

    const attempts = [];
    for (const [selLabel, sel] of selections) {
        for (const [argLabel, build] of argShapes) {
            const label = selLabel + " " + argLabel;
            try {
                const action = await editor.createRemoveItemsAction(...build(sel));
                try {
                    project.lockedAccess(() => {
                        project.executeTransaction((c) => {
                            c.addAction(action);
                        }, "PremBot: clear V1");
                    });
                } catch (txErr) {
                    attempts.push({ tried: label, txError: txErr.message || String(txErr) });
                    continue;
                }
                return Object.assign({ ok: true, used: label, cleared: items.length },
                    ctx, { attempts });
            } catch (e) {
                attempts.push({ tried: label, factoryError: e.message || String(e) });
            }
        }
    }
    throw new Error("All clearV1 attempts failed: ctx=" + JSON.stringify(ctx)
        + " attempts=" + JSON.stringify(attempts, null, 2));
}

// ---- Panel wiring ----

function showResult(out, label, value) {
    const json = (() => {
        try { return JSON.stringify(value, null, 2); }
        catch (e) { return String(value); }
    })();
    out.textContent = "[" + new Date().toLocaleTimeString() + "] " + label + "\n\n" + json;
}

function showError(out, label, err) {
    out.textContent = "[" + new Date().toLocaleTimeString() + "] " + label + " FAILED\n\n"
        + (err && (err.stack || err.message || String(err)));
}

function attach(root) {
    const out = root.querySelector("#output");

    root.querySelector("#btn-ping").addEventListener("click", async () => {
        out.textContent = "Pinging...";
        try { showResult(out, "ping", await ping()); }
        catch (e) { showError(out, "ping", e); }
    });

    root.querySelector("#btn-project").addEventListener("click", async () => {
        out.textContent = "Listing project clips...";
        try {
            const clips = await listProjectClips();
            showResult(out, "listProjectClips (" + clips.length + ")", clips);
        } catch (e) { showError(out, "listProjectClips", e); }
    });

    root.querySelector("#btn-sequence").addEventListener("click", async () => {
        out.textContent = "Listing timeline clips...";
        try {
            const seq = await listSequenceClips();
            const total = seq.video.length + seq.audio.length;
            showResult(out, "listSequenceClips (" + total + " total)", seq);
        } catch (e) { showError(out, "listSequenceClips", e); }
    });

    root.querySelector("#btn-probe").addEventListener("click", async () => {
        out.textContent = "Probing factories...";
        try { showResult(out, "probeFactories", await probeFactories()); }
        catch (e) { showError(out, "probeFactories", e); }
    });

    root.querySelector("#btn-trim").addEventListener("click", async () => {
        out.textContent = "Trimming...";
        try { showResult(out, "trim", await trimFirstClipOutMinusOneSec()); }
        catch (e) { showError(out, "trim", e); }
    });

    root.querySelector("#btn-insert").addEventListener("click", async () => {
        out.textContent = "Inserting...";
        try { showResult(out, "insert", await insertFirstBinClipAtZero()); }
        catch (e) { showError(out, "insert", e); }
    });

    root.querySelector("#btn-clear-v1").addEventListener("click", async () => {
        out.textContent = "Clearing V1...";
        try { showResult(out, "clearV1", await clearV1()); }
        catch (e) { showError(out, "clearV1", e); }
    });

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

entrypoints.setup({
    panels: {
        primary: {
            create(rootNode) {
                // index.html is already rendered as the document; rootNode here
                // is the panel's root. We attach handlers to the document body
                // since our markup lives there.
                attach(document);
            },
            show()   {},
            hide()   {},
            destroy(){}
        }
    }
});
