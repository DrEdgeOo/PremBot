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
    return { project, sequence };
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
            items.forEach((clip, ci) => {
                let inSec = null, outSec = null;
                try {
                    const inT = clip.getInPoint();
                    if (inT) inSec = inT.seconds;
                } catch (e) {}
                try {
                    const outT = clip.getOutPoint();
                    if (outT) outSec = outT.seconds;
                } catch (e) {}
                out[kind].push({
                    trackIndex: ti, clipIndex: ci,
                    name: clip.name,
                    inSeconds: inSec, outSeconds: outSec
                });
            });
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
    const { project, sequence } = await getContext();
    const report = {
        pproTopLevel: Object.keys(ppro).sort(),
        projectCreate: listMethods(project, "create"),
        projectMethods: listMethods(project, ""),
        sequenceCreate: sequence ? listMethods(sequence, "create") : null,
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
    }
    const root = await project.getRootItem();
    const projItems = await root.getItems();
    if (projItems && projItems.length > 0) {
        report.projectItemCreate = listMethods(projItems[0], "create");
        report.projectItemMethods = listMethods(projItems[0], "");
    }
    return report;
}

// ---- Mutation: clear all items from video track 0 ----
//
// Premiere UXP mutations go through executeTransaction. The exact factory
// name for "remove track item" varies across builds, so we try a chain of
// likely names and report which one (if any) accepted the call.

async function clearV1() {
    const { project, sequence } = await getContext();
    if (!sequence) throw new Error("No active sequence");
    const track = await sequence.getVideoTrack(0);
    const items = await track.getTrackItems(1, false);
    if (!items || items.length === 0) {
        return { cleared: 0, note: "V1 already empty" };
    }

    const candidates = [
        // [owner, factoryName, argsBuilder(trackItem)]
        ["sequence", "createRemoveItemAction",  (ti) => [ti, false, false]],
        ["sequence", "createRemoveItemAction",  (ti) => [ti]],
        ["sequence", "createRemoveItemsAction", (ti) => [[ti], false, false]],
        ["track",    "createRemoveItemAction",  (ti) => [ti, false, false]],
        ["track",    "createRemoveItemAction",  (ti) => [ti]],
        ["trackItem","createRemoveAction",      (_)  => []],
    ];

    const trace = [];
    let used = null;
    let firstTi = items[0];

    // First, sniff which candidate exists on a live object before we open
    // a transaction (transactions are expensive to abort).
    for (const [ownerName, fnName, _] of candidates) {
        const owner = ownerName === "sequence" ? sequence
                    : ownerName === "track"    ? track
                    : firstTi;
        if (owner && typeof owner[fnName] === "function") {
            used = { ownerName, fnName };
            break;
        }
    }
    if (!used) {
        return {
            cleared: 0,
            note: "No known remove-action factory found. Run Probe factories.",
            tried: candidates.map(([o, n]) => o + "." + n)
        };
    }

    await project.executeTransaction((compoundAction) => {
        for (const ti of items) {
            const owner = used.ownerName === "sequence" ? sequence
                        : used.ownerName === "track"    ? track
                        : ti;
            const argsBuilder = candidates.find(
                c => c[0] === used.ownerName && c[1] === used.fnName
            )[2];
            const action = owner[used.fnName](...argsBuilder(ti));
            compoundAction.addAction(action);
            trace.push(used.ownerName + "." + used.fnName + " on " + ti.name);
        }
    }, "PremBot: clear V1");

    return { cleared: items.length, factory: used, trace };
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

    root.querySelector("#btn-clear-v1").addEventListener("click", async () => {
        out.textContent = "Clearing V1...";
        try { showResult(out, "clearV1", await clearV1()); }
        catch (e) { showError(out, "clearV1", e); }
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
