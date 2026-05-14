// Promise-friendly wrapper around CSInterface.evalScript for ExtendScript calls.
// Every host function in host/index.jsx returns a JSON string {ok, data|error}.
var Host = (function () {
    var cs = (typeof CSInterface === 'function') ? new CSInterface() : null;

    function _esc(v) {
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return JSON.stringify(String(v));
    }

    function call(fnName, args) {
        return new Promise(function (resolve, reject) {
            if (!cs) return reject(new Error('CSInterface unavailable (not in CEP)'));
            var argList = (args || []).map(_esc).join(',');
            var script  = fnName + '(' + argList + ')';
            cs.evalScript(script, function (raw) {
                if (raw === 'EvalScript error.' || raw === 'undefined' || raw == null || raw === '') {
                    return reject(new Error('ExtendScript error in ' + fnName + ': ' + raw));
                }
                var parsed;
                try { parsed = JSON.parse(raw); }
                catch (e) { return reject(new Error('Bad JSON from ' + fnName + ': ' + raw)); }
                if (parsed && parsed.ok) resolve(parsed.data);
                else                     reject(new Error((parsed && parsed.error) || 'Unknown host error'));
            });
        });
    }

    return {
        ping:                  function ()                              { return call('pbPing'); },
        listProjectClips:      function ()                              { return call('pbListProjectClips'); },
        getActiveSequenceInfo: function ()                              { return call('pbGetActiveSequenceInfo'); },
        clearActiveSequence:   function ()                              { return call('pbClearActiveSequence'); },
        addSegment:            function (nodeId, sIn, sOut, tStart, track) {
            return call('pbAddSegment', [nodeId, sIn, sOut, tStart, track || 0]);
        }
    };
})();
