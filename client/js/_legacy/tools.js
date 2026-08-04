// Tool definitions for the Claude tool-use agent + their executors.
// Mutating tools obey the current Plan/Auto mode: in Plan mode we queue the
// operation and return a synthetic ok result; in Auto we execute against
// ExtendScript immediately.
var Tools = (function () {

    var definitions = [
        {
            name: 'list_clips',
            description: 'List every clip currently in the Premiere project with its node id, name, duration, and whether it has been transcribed.',
            input_schema: { type: 'object', properties: {} }
        },
        {
            name: 'search_transcripts',
            description: 'Keyword search across all transcribed clips. Returns matching segments with timestamps so you can decide which moments to cut into the timeline.',
            input_schema: {
                type: 'object',
                properties: {
                    query:        { type: 'string', description: 'Words or phrase to find in spoken audio (case-insensitive).' },
                    max_results:  { type: 'integer', description: 'Cap on results (default 25).' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_clip_transcript',
            description: 'Return the full transcript segments for a single clip.',
            input_schema: {
                type: 'object',
                properties: { clip_node_id: { type: 'string' } },
                required: ['clip_node_id']
            }
        },
        {
            name: 'clear_sequence',
            description: 'Remove every clip from the active sequence. Call this once at the start of building a fresh edit.',
            input_schema: { type: 'object', properties: {} }
        },
        {
            name: 'add_segment',
            description: 'Insert a portion of a clip onto the active sequence at a specific timeline time. Build the rough cut by calling this repeatedly with non-overlapping timeline ranges.',
            input_schema: {
                type: 'object',
                properties: {
                    clip_node_id:           { type: 'string',  description: 'Project item nodeId from list_clips.' },
                    source_in_seconds:      { type: 'number',  description: 'Start time within the source media (seconds).' },
                    source_out_seconds:     { type: 'number',  description: 'End time within the source media (seconds).' },
                    timeline_start_seconds: { type: 'number',  description: 'Where on the active sequence this segment begins (seconds).' },
                    track:                  { type: 'integer', description: '0-based video track index (default 0).' }
                },
                required: ['clip_node_id','source_in_seconds','source_out_seconds','timeline_start_seconds']
            }
        },
        {
            name: 'list_sequence_clips',
            description: 'List clips currently on the active sequence timeline by track. Returns video and audio tracks with each clip\'s trackIndex, clipIndex, name, start, and end (seconds). Use this before applying effects, fades, or transitions so you know how to address a clip.',
            input_schema: { type: 'object', properties: {} }
        },
        {
            name: 'set_audio_gain',
            description: 'Set the constant audio gain (in dB) on an audio clip on the timeline. -infinity is silence, 0 is unity. Typical mix range: -12 to +6.',
            input_schema: {
                type: 'object',
                properties: {
                    track_index: { type: 'integer', description: '0-based audio track index from list_sequence_clips.' },
                    clip_index:  { type: 'integer', description: '0-based clip index on that audio track.' },
                    db:          { type: 'number',  description: 'Gain in decibels (e.g. -6, 0, +3).' }
                },
                required: ['track_index', 'clip_index', 'db']
            }
        },
        {
            name: 'add_audio_fade',
            description: 'Add a fade-in or fade-out on an audio clip by keyframing its Volume Level. Use this for clean entries/exits or to duck under voiceover.',
            input_schema: {
                type: 'object',
                properties: {
                    track_index:  { type: 'integer' },
                    clip_index:   { type: 'integer' },
                    side:         { type: 'string', enum: ['in', 'out'], description: 'Fade in (start) or out (end).' },
                    duration_sec: { type: 'number', description: 'Length of the fade in seconds.' }
                },
                required: ['track_index', 'clip_index', 'side', 'duration_sec']
            }
        },
        {
            name: 'apply_clip_preset',
            description: 'Apply a Premiere preset file (.prfpset) to a timeline clip. The classic use is dropping a Lumetri Look on a video clip for color grading. The preset file must already exist on disk; pass its absolute path.',
            input_schema: {
                type: 'object',
                properties: {
                    track_kind:  { type: 'string', enum: ['video', 'audio'] },
                    track_index: { type: 'integer' },
                    clip_index:  { type: 'integer' },
                    preset_path: { type: 'string', description: 'Absolute path to a .prfpset file on the user\'s machine.' }
                },
                required: ['track_kind', 'track_index', 'clip_index', 'preset_path']
            }
        },
        {
            name: 'set_clip_speed',
            description: 'Change the playback speed of a timeline clip. 100 = normal, 50 = half-speed (slow motion), 200 = double-speed. Affects both video and audio clip duration.',
            input_schema: {
                type: 'object',
                properties: {
                    track_kind:    { type: 'string', enum: ['video', 'audio'] },
                    track_index:   { type: 'integer' },
                    clip_index:    { type: 'integer' },
                    speed_percent: { type: 'number', description: 'Speed as a percentage; 100 = normal.' }
                },
                required: ['track_kind', 'track_index', 'clip_index', 'speed_percent']
            }
        },
        {
            name: 'finish',
            description: 'Call once the edit plan is complete. Provide a short summary of what you built and any caveats.',
            input_schema: {
                type: 'object',
                properties: { summary: { type: 'string' } },
                required: ['summary']
            }
        }
    ];

    // --- Read-only tool implementations (always live) ---

    async function _list_clips(_input, ctx) {
        var clips = await Host.listProjectClips();
        var transcripts = ctx.transcripts || {};
        return clips.map(function (c) {
            var tr = transcripts[c.path];
            return {
                node_id:      c.nodeId,
                name:         c.name,
                path:         c.path,
                duration:     tr ? tr.duration : null,
                transcribed:  !!tr
            };
        });
    }

    async function _get_clip_transcript(input, ctx) {
        var clips = await Host.listProjectClips();
        var clip = clips.find(function (c) { return String(c.nodeId) === String(input.clip_node_id); });
        if (!clip) throw new Error('No clip with node_id ' + input.clip_node_id);
        var tr = (ctx.transcripts || {})[clip.path];
        if (!tr) throw new Error('Clip not transcribed yet: ' + clip.name);
        return { name: clip.name, duration: tr.duration, segments: tr.segments };
    }

    async function _search_transcripts(input, ctx) {
        var q = String(input.query || '').toLowerCase();
        var cap = input.max_results || 25;
        var transcripts = ctx.transcripts || {};
        var clips = await Host.listProjectClips();
        var byPath = {};
        clips.forEach(function (c) { byPath[c.path] = c; });

        var hits = [];
        Object.keys(transcripts).forEach(function (path) {
            var clip = byPath[path];
            if (!clip) return;
            (transcripts[path].segments || []).forEach(function (s) {
                if (s.text.toLowerCase().indexOf(q) !== -1) {
                    hits.push({
                        clip_node_id: clip.nodeId,
                        clip_name:    clip.name,
                        start:        s.start,
                        end:          s.end,
                        text:         s.text
                    });
                }
            });
        });
        return hits.slice(0, cap);
    }

    // --- Mutating tool implementations (gated by mode) ---

    async function _clear_sequence(_input, ctx) {
        if (ctx.mode === 'plan') {
            ctx.plan.push({ kind: 'clear_sequence' });
            return { queued: true, note: 'Will clear active sequence on Apply.' };
        }
        return await Host.clearActiveSequence();
    }

    async function _add_segment(input, ctx) {
        var clipName = input.clip_node_id;
        try {
            var clips = await Host.listProjectClips();
            var clip = clips.find(function (c) { return String(c.nodeId) === String(input.clip_node_id); });
            if (clip) clipName = clip.name;
        } catch (e) {}

        if (ctx.mode === 'plan') {
            ctx.plan.push({
                kind:           'add_segment',
                clip_node_id:   input.clip_node_id,
                clip_name:      clipName,
                source_in:      input.source_in_seconds,
                source_out:     input.source_out_seconds,
                timeline_start: input.timeline_start_seconds,
                track:          input.track || 0
            });
            return { queued: true };
        }
        return await Host.addSegment(
            input.clip_node_id,
            input.source_in_seconds,
            input.source_out_seconds,
            input.timeline_start_seconds,
            input.track || 0
        );
    }

    async function _list_sequence_clips(_input, _ctx) {
        return await Host.listSequenceClips();
    }

    async function _set_audio_gain(input, ctx) {
        if (ctx.mode === 'plan') {
            ctx.plan.push({
                kind: 'set_audio_gain',
                track_index: input.track_index, clip_index: input.clip_index, db: input.db
            });
            return { queued: true };
        }
        return await Host.setClipAudioGain(input.track_index, input.clip_index, input.db);
    }

    async function _add_audio_fade(input, ctx) {
        if (ctx.mode === 'plan') {
            ctx.plan.push({
                kind: 'add_audio_fade',
                track_index: input.track_index, clip_index: input.clip_index,
                side: input.side, duration_sec: input.duration_sec
            });
            return { queued: true };
        }
        return await Host.addAudioFade(input.track_index, input.clip_index, input.side, input.duration_sec);
    }

    async function _apply_clip_preset(input, ctx) {
        if (ctx.mode === 'plan') {
            ctx.plan.push({
                kind: 'apply_clip_preset',
                track_kind: input.track_kind, track_index: input.track_index,
                clip_index: input.clip_index, preset_path: input.preset_path
            });
            return { queued: true };
        }
        return await Host.applyClipPreset(input.track_kind, input.track_index, input.clip_index, input.preset_path);
    }

    async function _set_clip_speed(input, ctx) {
        if (ctx.mode === 'plan') {
            ctx.plan.push({
                kind: 'set_clip_speed',
                track_kind: input.track_kind, track_index: input.track_index,
                clip_index: input.clip_index, speed_percent: input.speed_percent
            });
            return { queued: true };
        }
        return await Host.setClipSpeed(input.track_kind, input.track_index, input.clip_index, input.speed_percent);
    }

    async function _finish(input, ctx) {
        ctx.finished = true;
        ctx.summary  = input.summary || '';
        return { done: true };
    }

    var executors = {
        list_clips:          _list_clips,
        get_clip_transcript: _get_clip_transcript,
        search_transcripts:  _search_transcripts,
        list_sequence_clips: _list_sequence_clips,
        clear_sequence:      _clear_sequence,
        add_segment:         _add_segment,
        set_audio_gain:      _set_audio_gain,
        add_audio_fade:      _add_audio_fade,
        apply_clip_preset:   _apply_clip_preset,
        set_clip_speed:      _set_clip_speed,
        finish:              _finish
    };

    async function run(name, input, ctx) {
        var fn = executors[name];
        if (!fn) throw new Error('Unknown tool: ' + name);
        return await fn(input || {}, ctx);
    }

    // Execute a queued plan against ExtendScript. Used when user clicks "Apply".
    async function applyPlan(plan) {
        var applied = [];
        for (var i = 0; i < plan.length; i++) {
            var step = plan[i];
            if (step.kind === 'clear_sequence') {
                await Host.clearActiveSequence();
                applied.push('Cleared sequence');
            } else if (step.kind === 'add_segment') {
                await Host.addSegment(
                    step.clip_node_id, step.source_in, step.source_out,
                    step.timeline_start, step.track
                );
                applied.push('Inserted ' + step.clip_name + ' at ' + step.timeline_start.toFixed(2) + 's');
            } else if (step.kind === 'set_audio_gain') {
                await Host.setClipAudioGain(step.track_index, step.clip_index, step.db);
                applied.push('Set audio gain ' + step.db + ' dB on A' + step.track_index + ' clip ' + step.clip_index);
            } else if (step.kind === 'add_audio_fade') {
                await Host.addAudioFade(step.track_index, step.clip_index, step.side, step.duration_sec);
                applied.push('Fade ' + step.side + ' ' + step.duration_sec + 's on A' + step.track_index + ' clip ' + step.clip_index);
            } else if (step.kind === 'apply_clip_preset') {
                await Host.applyClipPreset(step.track_kind, step.track_index, step.clip_index, step.preset_path);
                applied.push('Applied preset to ' + step.track_kind[0].toUpperCase() + step.track_index + ' clip ' + step.clip_index);
            } else if (step.kind === 'set_clip_speed') {
                await Host.setClipSpeed(step.track_kind, step.track_index, step.clip_index, step.speed_percent);
                applied.push('Speed ' + step.speed_percent + '% on ' + step.track_kind[0].toUpperCase() + step.track_index + ' clip ' + step.clip_index);
            }
        }
        return applied;
    }

    return { definitions: definitions, run: run, applyPlan: applyPlan };
})();
