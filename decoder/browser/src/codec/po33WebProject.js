/** Translate the existing web engine into hardware state, preserving untouched native fields. */
import { compileProject, emptyProject } from "../../decoder/vendor/so-sample/project.js?v=web-sampler-0.2.34";
import { cloneState } from "../../decoder/vendor/so-sample/state.js?v=web-sampler-0.2.34";
import { emptyPattern, writeCell, readCell, writeEffects } from "../../decoder/vendor/so-sample/pattern.js?v=web-sampler-0.2.34";
import { encodeMulaw, SAMPLE_RATE } from "../../decoder/vendor/so-sample/mulaw.js?v=web-sampler-0.2.34";
import { toNativeRate } from "../../decoder/vendor/so-sample/resample.js?v=web-sampler-0.2.34";
import { writeTempo, writeSwing, writeChain } from "../../decoder/vendor/so-sample/globals.js?v=web-sampler-0.2.34";
import { EMPTY_GLOBALS } from "./po33Template.js?v=web-sampler-0.2.34";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(x)));
export function buildHardwareProject(snapshot, native, baseline) {
    if (snapshot.slots.length !== 16 || snapshot.patterns.length !== 16 || snapshot.tweaks.length !== 16)
        throw Error('Invalid web project shape');
    const warnings = [];
    const template = native ? cloneState(native.raw.state) : {
        globals: EMPTY_GLOBALS.map(g => Uint8Array.from(g)), patterns: Array.from({ length: 16 }, emptyPattern), sounds: Array(136).fill(null)
    };
    const model = emptyProject(snapshot.bpm), codes = new Map();
    model.chain = snapshot.chain.length ? snapshot.chain : [snapshot.pattern];
    model.swing = native && baseline && snapshot.swing === baseline.swing ? native.meta.swingRaw : clamp(snapshot.swing * 18, 0, 18);
    const sampleKey = (s) => ({ slots: s.slots, assets: s.assets.map(a => [a.id, a.rate, a.data.length]), trim: s.tweaks.map(t => [t.start, t.length, t.slices, t.frames]) });
    const unchangedSamples = !!(native && baseline && equal(sampleKey(snapshot), sampleKey(baseline)));
    const resolve = (id) => {
        let c = codes.get(id);
        if (c)
            return c;
        const a = snapshot.assets.find(a => a.id === id);
        if (!a)
            throw Error('Missing sample asset ' + id);
        if (a.data.length / a.rate > 43 || !a.data.every(Number.isFinite))
            throw Error('Invalid sample asset');
        const pcm = a.rate === SAMPLE_RATE ? Float64Array.from(a.data) : toNativeRate(a.data, a.rate);
        for (let i = 0; i < pcm.length; i++)
            pcm[i] = Math.max(-1, Math.min(1, pcm[i]));
        c = encodeMulaw(pcm);
        codes.set(id, c);
        return c;
    };
    const clip = (v, start = 0, length = 100, frames) => {
        if (!v)
            return null;
        const total = resolve(v.asset).length;
        const sourceRate = snapshot.assets.find(a => a.id === v.asset).rate;
        const first = frames ? clamp(frames.start / sourceRate * SAMPLE_RATE, 0, total) : clamp((v.offset + v.duration * start / 100) * SAMPLE_RATE, 0, total);
        const end = frames ? clamp(frames.end / sourceRate * SAMPLE_RATE, first, total) : clamp((v.offset + v.duration * (start / 100 + (1 - start / 100) * length / 100)) * SAMPLE_RATE, first, total);
        if (first < 0 || first >= total || end <= first)
            return null;
        return { sampleId: v.asset, start: first, end: Math.min(total, end) };
    };
    if (!unchangedSamples)
        snapshot.slots.forEach((slot, i) => {
            if (!slot)
                return;
            const t = snapshot.tweaks[i];
            if (i < 8)
                model.melodic[i] = clip(slot, t.start, t.length, t.frames);
            else
                model.drums[i - 8] = { slices: Array.from({ length: 16 }, (_, k) => {
                        const trim = t.slices[k] || { start: 0, length: 100 };
                        return clip(slot.slices ? slot.slices[k] : { asset: slot.asset, offset: slot.offset + slot.duration * k / 16, duration: slot.duration / 16 }, trim.start, trim.length, trim.frames);
                    }) };
        });
    const volumeGain = (v) => v <= 100 ? v / 100 : 1 + (v - 100) / 100 * ((63 * 63 + 240) / 1536 - 1);
    const params = (t) => ({ pitch: clamp((t.pitch || 0) + 13, 1, 25), volume: clamp(Math.sqrt(Math.max(0, volumeGain(t.volume ?? 100) * 1536 - 240)), 1, 63), filter: Math.abs(t.filter || 0) <= 4 ? 63 : clamp((t.filter || 0) < 0 ? 1 + ((t.filter || 0) + 100) * 30 / 95 : 32 + ((t.filter || 0) - 5) * 30 / 95, 1, 62), resonance: clamp((t.resonance || 0) * .62 + 1, 1, 63) });
    model.patterns = snapshot.patterns.map((p, index) => {
        const raw = native ? native.patterns[index].raw.slice() : emptyPattern();
        const extra = snapshot.extras[index], prev = baseline?.extras[index];
        const clear = baseline && baseline.patterns[index].lanes.some(l => l.some(n => n >= 0)) && !p.lanes.some(l => l.some(n => n >= 0)) && !Object.keys(extra.locks).length;
        if (clear)
            raw.fill(0, 0, 1024);
        const carried = snapshot.tweaks.map(t => ({ ...t }));
        for (let step = 0; step < 16; step++)
            for (let i = 0; i < 16; i++) {
                const key = i + ':' + step, note = p.lanes[i][step], lock = extra.locks[key];
                for (const k of ['pitch', 'volume', 'filter', 'resonance'])
                    if (Number.isFinite(lock?.[k]))
                        carried[i][k] = lock[k];
                const t = carried[i];
                if (native && baseline && !clear && note === baseline.patterns[index].lanes[i][step] && equal(extra.locks[key], prev?.locks[key]) && equal(extra.steps?.[key], prev?.steps?.[key]) && equal(snapshot.tweaks[i], baseline.tweaks[i]))
                    continue;
                if (note < 0) {
                    const codes = params(lock || {}), word = { pitch: 0, volume: 0, filter: 0, resonance: 0 };
                    for (const k of ['pitch', 'volume', 'filter', 'resonance'])
                        if (Number.isFinite(lock?.[k]))
                            word[k] = codes[k];
                    writeCell(raw, step + 1, i + 1, Object.values(word).some(Boolean) ? { ...word, key: null } : null);
                    continue;
                }
                const previous = readCell(raw, step + 1, i + 1);
                const lockChanged = !baseline || !equal(extra.locks[key], prev?.locks[key]) || !equal(snapshot.tweaks[i], baseline.tweaks[i]);
                const detail = extra.steps?.[key], retrigs = detail?.retrigs || 1;
                const timing = i < 8 ? (detail?.length || 15) : retrigs;
                writeCell(raw, step + 1, i + 1, { ...(previous && !lockChanged ? previous : params(t)), key: clamp(note + 1, 1, 16), timing: clamp(timing, 1, 15) });
            }
        if (!native || !baseline || !equal(extra.effects, prev?.effects))
            writeEffects(raw, Array.from({ length: 16 }, (_, k) => { const f = extra.effects[k]; return f > 0 && f < 16 ? f : null; }));
        return raw;
    });
    let state;
    if (unchangedSamples) {
        state = template;
        state.patterns = model.patterns;
        writeTempo(state.globals[1], snapshot.bpm);
        writeSwing(state.globals[1], model.swing);
        writeChain(state.globals[1], model.chain);
    }
    else {
        const total = snapshot.assets.filter(a => snapshot.slots.some(s => s && (s.asset === a.id || s.slices?.some(v => v?.asset === a.id)))).reduce((n, a) => n + a.data.length / a.rate, 0);
        if (total > 40.001 && !native)
            throw Error('Samples exceed the 40-second hardware recording budget');
        state = compileProject(model, resolve, template);
        if (native)
            warnings.push('Sample edits rebuilt pool layout. Unavailable source slices cannot be recreated. Original source frame remains available in the saved checkpoint.');
    }
    if (!native || !baseline || !equal(snapshot.tweaks, baseline.tweaks) || !equal(snapshot.extras.map(e => e.locks), baseline.extras.map(e => e.locks)))
        warnings.push('New web parameter locks use approximate hardware code mappings; filter/resonance use a recorded magnitude-response fit; volume uses the recorded relative-gain fit.');
    if (snapshot.tweaks.some(t => !Number.isInteger(t.pitch)) || snapshot.extras.some(e => Object.values(e.locks).some(t => t.pitch !== undefined && !Number.isInteger(t.pitch))))
        warnings.push('Continuous audition pitch is rounded to the native step-code grid on export.');
    return { raw: { state }, warnings };
}
