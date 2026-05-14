// Claude tool-use agent loop. Calls api.anthropic.com directly with the user's
// own key (personal-use BYO). Streams tool_use blocks, executes them via Tools.run,
// feeds tool_result blocks back, loops until stop_reason !== "tool_use" or finish().
var Agent = (function () {
    var API_URL    = 'https://api.anthropic.com/v1/messages';
    var MAX_TURNS  = 20;
    var MAX_TOKENS = 4096;

    function _systemPrompt(stylePrompt, seqInfo) {
        var seq = seqInfo
            ? 'Active sequence: "' + seqInfo.name + '" with ' +
              seqInfo.videoTracks + ' video tracks, ' + seqInfo.audioTracks + ' audio tracks.'
            : 'No active sequence. Ask the user to create one in Premiere before building a cut.';

        return [
            'You are PremBot, an AI video editor embedded inside Adobe Premiere Pro.',
            'You build rough cuts on the active timeline by calling tools.',
            '',
            'Operating principles:',
            '- Begin by calling list_clips to discover available footage.',
            '- Use search_transcripts or get_clip_transcript to find the right spoken moments.',
            '- Always call clear_sequence before laying down a fresh edit (unless the user says to append).',
            '- Place segments end-to-end with NO overlap: timeline_start_seconds of each segment must equal the previous segment\'s end on the timeline.',
            '- Keep segment durations between 1.5s and 12s unless the user asks otherwise.',
            '- Respect the user\'s house style below.',
            '- After segments are placed you may polish: call list_sequence_clips to address timeline clips, then use set_audio_gain, add_audio_fade, apply_clip_preset (for Lumetri/color), and add_transition. Use these sparingly and only when the user asks for polish.',
            '- When done, call finish with a 1-3 sentence summary of the cut and any caveats.',
            '',
            seq,
            '',
            'House style:',
            stylePrompt
        ].join('\n');
    }

    async function _callClaude(settings, messages, system) {
        var body = {
            model:       settings.model || 'claude-sonnet-4-6',
            max_tokens:  MAX_TOKENS,
            system:      system,
            tools:       Tools.definitions,
            messages:    messages
        };
        var res = await fetch(API_URL, {
            method:  'POST',
            headers: {
                'Content-Type':                          'application/json',
                'x-api-key':                             settings.anthropicKey,
                'anthropic-version':                     '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) {
            var t = await res.text();
            throw new Error('Anthropic ' + res.status + ': ' + t);
        }
        return await res.json();
    }

    // Run a single user request to completion (multi-turn tool loop).
    // onEvent({ type, ... }) is called with: 'assistant_text', 'tool_use', 'tool_result', 'done', 'error'.
    async function run({ userPrompt, settings, mode, transcripts, seqInfo, onEvent }) {
        if (!settings.anthropicKey) throw new Error('Anthropic API key missing (Settings tab).');

        var ctx = {
            mode:        mode,            // 'plan' | 'auto'
            plan:        [],              // queued mutating ops in plan mode
            transcripts: transcripts,
            finished:    false,
            summary:     ''
        };

        var system = _systemPrompt(settings.styleProfile || '', seqInfo);
        var messages = [{ role: 'user', content: userPrompt }];

        for (var turn = 0; turn < MAX_TURNS; turn++) {
            var resp;
            try { resp = await _callClaude(settings, messages, system); }
            catch (e) { onEvent({ type: 'error', error: e.message }); throw e; }

            messages.push({ role: 'assistant', content: resp.content });

            // Surface any assistant text immediately.
            (resp.content || []).forEach(function (block) {
                if (block.type === 'text' && block.text) {
                    onEvent({ type: 'assistant_text', text: block.text });
                }
            });

            var toolUses = (resp.content || []).filter(function (b) { return b.type === 'tool_use'; });
            if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
                onEvent({ type: 'done', plan: ctx.plan, summary: ctx.summary });
                return ctx;
            }

            var toolResults = [];
            for (var i = 0; i < toolUses.length; i++) {
                var tu = toolUses[i];
                onEvent({ type: 'tool_use', name: tu.name, input: tu.input });
                var result, isError = false;
                try {
                    result = await Tools.run(tu.name, tu.input, ctx);
                } catch (e) {
                    isError = true;
                    result  = { error: e.message || String(e) };
                }
                onEvent({ type: 'tool_result', name: tu.name, result: result, isError: isError });
                toolResults.push({
                    type:        'tool_result',
                    tool_use_id: tu.id,
                    content:     JSON.stringify(result),
                    is_error:    isError
                });
                if (ctx.finished) break;
            }

            messages.push({ role: 'user', content: toolResults });

            if (ctx.finished) {
                onEvent({ type: 'done', plan: ctx.plan, summary: ctx.summary });
                return ctx;
            }
        }

        onEvent({ type: 'done', plan: ctx.plan, summary: ctx.summary, truncated: true });
        return ctx;
    }

    return { run: run };
})();
