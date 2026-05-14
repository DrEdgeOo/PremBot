// Minimal CSInterface shim — sufficient subset of Adobe-CEP's CSInterface.js for PremBot.
// Adobe-CEP's full lib is BSD-licensed; this trimmed version covers our needs.

function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
    if (typeof callback !== 'function') callback = function () {};
    if (window.__adobe_cep__) {
        window.__adobe_cep__.evalScript(script, callback);
    } else {
        // Running outside Premiere (e.g. dev preview in a browser) — fake it.
        console.warn('[CSInterface] evalScript called outside CEP:', script);
        callback(JSON.stringify({ ok: false, error: 'Not running in CEP host' }));
    }
};

CSInterface.prototype.getSystemPath = function (pathType) {
    return window.__adobe_cep__ ? window.__adobe_cep__.getSystemPath(pathType) : '';
};

CSInterface.prototype.getHostEnvironment = function () {
    if (!window.__adobe_cep__) return {};
    try { return JSON.parse(window.__adobe_cep__.getHostEnvironment()); }
    catch (e) { return {}; }
};

CSInterface.prototype.addEventListener = function (type, listener, obj) {
    if (window.__adobe_cep__) window.__adobe_cep__.addEventListener(type, listener, obj);
};

CSInterface.prototype.requestOpenExtension = function (extensionId, params) {
    if (window.__adobe_cep__) window.__adobe_cep__.requestOpenExtension(extensionId, params);
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
        window.cep.util.openURLInDefaultBrowser(url);
    }
};
