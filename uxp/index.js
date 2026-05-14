// PremBot UXP entry. Goal of this first cut: load the panel, import the
// premierepro module, and dump enough of its surface that we can plan the
// real bridge with eyes open. No agent logic yet - that comes once we
// confirm the module shape.

(function () {
    const btn = document.getElementById('probe-btn');
    const out = document.getElementById('probe-out');

    function show(label, value) {
        out.textContent += '\n--- ' + label + ' ---\n' + value + '\n';
    }

    function safeStringify(value) {
        try { return JSON.stringify(value, null, 2); }
        catch (e) { return '[unstringifiable: ' + (e && e.message) + ']'; }
    }

    function describe(obj) {
        if (obj === null) return 'null';
        if (obj === undefined) return 'undefined';
        const t = typeof obj;
        if (t !== 'object' && t !== 'function') return t + ': ' + String(obj);
        const keys = [];
        try {
            for (const k of Object.getOwnPropertyNames(obj)) {
                try { keys.push(k + ' (' + (typeof obj[k]) + ')'); }
                catch (e) { keys.push(k + ' (err: ' + (e && e.message) + ')'); }
            }
        } catch (e) { return 'enumeration failed: ' + (e && e.message); }
        try {
            const proto = Object.getPrototypeOf(obj);
            if (proto && proto !== Object.prototype) {
                for (const k of Object.getOwnPropertyNames(proto)) {
                    try { keys.push('[proto] ' + k + ' (' + (typeof obj[k]) + ')'); }
                    catch (e) {}
                }
            }
        } catch (e) {}
        return keys.sort().join('\n');
    }

    btn.addEventListener('click', async function () {
        out.textContent = 'Probing...';
        try {
            const ppro = require('premierepro');
            out.textContent = '';
            show('typeof require("premierepro")', typeof ppro);
            show('premierepro module keys', describe(ppro));

            // Try to find a Project / project getter.
            let project = null;
            try {
                if (ppro.Project && typeof ppro.Project.getActiveProject === 'function') {
                    project = await ppro.Project.getActiveProject();
                } else if (typeof ppro.getActiveProject === 'function') {
                    project = await ppro.getActiveProject();
                } else if (ppro.app && typeof ppro.app.getActiveProject === 'function') {
                    project = await ppro.app.getActiveProject();
                }
            } catch (e) { show('getActiveProject error', e && e.message); }

            if (project) {
                show('project keys', describe(project));
                try {
                    const name = (typeof project.getName === 'function') ? await project.getName() : project.name;
                    show('project.name', String(name));
                } catch (e) { show('project name error', e && e.message); }

                try {
                    const seq = (typeof project.getActiveSequence === 'function')
                        ? await project.getActiveSequence() : null;
                    if (seq) {
                        show('activeSequence keys', describe(seq));
                        try {
                            const sname = (typeof seq.getName === 'function') ? await seq.getName() : seq.name;
                            show('activeSequence.name', String(sname));
                        } catch (e) {}
                    } else {
                        show('activeSequence', 'null (no sequence open?)');
                    }
                } catch (e) { show('getActiveSequence error', e && e.message); }
            } else {
                show('project', 'null - could not get active project');
            }
        } catch (e) {
            out.textContent = 'Probe failed:\n' + (e && (e.stack || e.message || String(e)));
        }
    });
})();
