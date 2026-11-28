/** Stereo DQPSK synthesis ported from libpo po_stereo.c @ bd56423d (MIT).
 * See decoder/vendor/libpo/LICENSE and PROVENANCE.md. No audio APIs or resampling.
 */
import { encodePackets, TAG } from "../../decoder/vendor/so-sample/packets.js?v=web-sampler-0.2.36";
import { serializeState } from "../../decoder/vendor/so-sample/state.js?v=web-sampler-0.2.36";
export function encodePO33Frame(state) {
    const body = encodePackets(serializeState(state)), wire = new Uint8Array(4096 + body.length);
    for (let i = 0; i < 4092; i++)
        wire[i] = i & 255;
    wire.set([0x4d, 0xb8, 0x16, 0x5d], 4092);
    wire.set(body, 4096);
    return wire;
}
export function encodePO33Backup(project, targetSampleRate = 44100, onProgress) {
    if (![44100, 48000, 96000].includes(targetSampleRate))
        throw Error('Backup output rate must be 44100, 48000 or 96000 Hz');
    const packets = serializeState(project.raw.state), body = encodePackets(packets);
    const wire = new Uint8Array(4096 + body.length);
    for (let i = 0; i < 4092; i++)
        wire[i] = i & 255;
    wire.set([0x4d, 0xb8, 0x16, 0x5d], 4092);
    wire.set(body, 4096);
    const active = Math.ceil((wire.length * 2 + 129) * targetSampleRate / 7812.5);
    const lead = Math.round(targetSampleRate * 1.5), frames = active + lead + targetSampleRate / 4;
    if (frames * 4 > 128 * 1024 * 1024 || frames > targetSampleRate * 600)
        throw Error('Encoded backup exceeds transfer limits');
    const wav = new ArrayBuffer(44 + frames * 4), dv = new DataView(wav);
    const ascii = (at, s) => { for (let i = 0; i < s.length; i++)
        dv.setUint8(at + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF');
    dv.setUint32(4, 36 + frames * 4, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true);
    dv.setUint32(24, targetSampleRate, true);
    dv.setUint32(28, targetSampleRate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 16, true);
    ascii(36, 'data');
    dv.setUint32(40, frames * 4, true);
    const phase = [0, 0], next = [0, 0];
    let symbol = 0;
    const nibble = (s) => s < wire.length * 2 ? (wire[s >> 1] >> ((s & 1) * 4)) & 15 : 0;
    next[0] = nibble(0) >> 2;
    next[1] = nibble(0) & 3;
    const wave = (p, s, c) => p === 0 ? s : p === 1 ? c : p === 2 ? -s : -c;
    for (let j = 0; j < active; j++) {
        const position = j * 7812.5 / targetSampleRate, step = Math.floor(position), fraction = position - step;
        while (symbol < step) {
            phase[0] = next[0];
            phase[1] = next[1];
            const n = nibble(++symbol);
            next[0] = (phase[0] + (n >> 2)) & 3;
            next[1] = (phase[1] + (n & 3)) & 3;
        }
        const s = Math.sin(2 * Math.PI * fraction), c = Math.cos(2 * Math.PI * fraction);
        const mix = fraction < .6 ? 0 : fraction > .9 ? 1 : (fraction - .6) / .3;
        for (let ch = 0; ch < 2; ch++) {
            const x = .6 * ((1 - mix) * wave(phase[ch], s, c) + mix * wave(next[ch], s, c));
            dv.setInt16(44 + ((lead + j) * 2 + ch) * 2, Math.floor(x * 32768 + 2 ** -17), true);
        }
        if (j % 65536 === 0)
            onProgress?.({ phase: 'encode', completed: j, total: active });
    }
    onProgress?.({ phase: 'encode', completed: active, total: active });
    return wav;
}
/** Real byte offsets for LED stages, rather than a fabricated sound-first sequence. */
export function transferTimeline(state, sampleRate = 44100) {
    const events = [{ frame: 0, phase: 'lead-in', record: 0 }, { frame: Math.round(sampleRate * 1.5), phase: 'preamble', record: 0 }];
    let bytes = 4096;
    for (const p of serializeState(state)) {
        if (p.tag === TAG.PATTERN_SELECT || p.tag === TAG.SOUND_SELECT)
            events.push({
                frame: Math.floor(sampleRate * 1.5 + bytes * 2 / 7812.5 * sampleRate),
                phase: p.tag === TAG.PATTERN_SELECT ? 'pattern' : 'sound',
                record: p.tag === TAG.PATTERN_SELECT ? p.payload[0] + 1 : p.payload[0] < 8 ? p.payload[0] + 1 : 9 + Math.floor((p.payload[0] - 8) / 16)
            });
        bytes += p.payload.length + 5;
    }
    return events;
}
