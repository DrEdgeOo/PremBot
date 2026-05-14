// PremBot UXP entry. Iteration 2 probe: drill into the layers we need
// for primitives - project root item, tracks, track items, factories.

(function () {
    const btn = document.getElementById('probe-btn');
    const out = document.getElementById('probe-out');

    function show(label, value) {
        out.textContent += '\n--- ' + label + ' ---\n' + value + '\n';
    }

    function describe(obj) {
        if (obj === null) return 'null';
        if (obj === undefined) return 'undefined';
        const t = typeof obj;
        if (t !== 'object' && t !== 'function') return t + ': ' + String(obj);
        const keys = [];
        const seen = new Set();
        function add(k, source) {
            if (seen.has(k)) return;
            seen.add(k);
            try { keys.push(source + k + ' (' + (typeof obj[k]) + ')'); }
            catch (e) { keys.push(source + k + ' (err)'); }
        }
        try { for (const k of Object.getOwnPropertyNames(obj)) add(k, ''); } catch (e) {}
        try {
            const proto = Object.getPrototypeOf(obj);
            if (proto && proto !== Object.prototype) {
                for (const k of Object.getOwnPropertyNames(proto)) add(k, '[proto] ');
            }
        } catch (e) {}
        return keys.sort().join('\n');
    }

    async function tryGet(label, fn) {
        try {
            const v = await fn();
            return v;
        } catch (e) {
            show(label + ' threw', (e && (e.message || String(e))));
            return null;
        }
    }

    btn.addEventListener('click', async function () {
        out.textContent = 'Probing...';
        try {
            const ppro = require('premierepro');
            out.textContent = '';

            // Project.
            const project = await tryGet('Project.getActiveProject', () => ppro.Project.getActiveProject());
            if (!project) { show('project', 'null'); return; }
            show('project.name', String(project.name));

            // Root item (project bin tree).
            const root = await tryGet('project.getRootItem', () => project.getRootItem());
            if (root) {
                show('root keys', describe(root));
                // Try a few likely enumeration methods.
                for (const m of ['getItems','getChildren','getProjectItems','children','items']) {
                    if (typeof root[m] === 'function') {
                        const children = await tryGet('root.' + m + '()', () => root[m]());
                        if (children) {
                            show('root.' + m + ' result type', typeof children + (Array.isArray(children) ? ' (array len ' + children.length + ')' : ''));
                            if (Array.isArray(children) && children.length) {
                                show('first child keys', describe(children[0]));
                                show('first child.name', String(children[0].name || '(no .name)'));
                            }
                            break;
                        }
                    }
                }
            }

            // Active sequence.
            const seq = await tryGet('project.getActiveSequence', () => project.getActiveSequence());
            if (!seq) { show('activeSequence', 'null'); }
            else {
                show('seq.name', String(seq.name));

                const vCount = await tryGet('seq.getVideoTrackCount', () => seq.getVideoTrackCount());
                const aCount = await tryGet('seq.getAudioTrackCount', () => seq.getAudioTrackCount());
                show('track counts', 'video=' + vCount + ' audio=' + aCount);

                if (vCount > 0) {
                    const track = await tryGet('seq.getVideoTrack(0)', () => seq.getVideoTrack(0));
                    if (track) {
                        show('videoTrack[0] keys', describe(track));
                        // Probe for trackItem enumeration.
                        for (const m of ['getTrackItems','getClips','getItems','trackItems','clips']) {
                            if (typeof track[m] === 'function') {
                                const items = await tryGet('track.' + m + '()', () => track[m]());
                                if (items) {
                                    show('track.' + m + ' result', typeof items + (Array.isArray(items) ? ' (array len ' + items.length + ')' : ''));
                                    if (Array.isArray(items) && items.length) {
                                        show('first trackItem keys', describe(items[0]));
                                        show('first trackItem.name', String(items[0].name || '(no .name)'));
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Factories.
            for (const f of ['TransitionFactory','VideoFilterFactory','AudioFilterFactory','SequenceEditor','SequenceUtils','ProjectUtils']) {
                if (ppro[f]) {
                    show(f + ' keys', describe(ppro[f]));
                }
            }

        } catch (e) {
            out.textContent = 'Probe failed:\n' + (e && (e.stack || e.message || String(e)));
        }
    });
})();
