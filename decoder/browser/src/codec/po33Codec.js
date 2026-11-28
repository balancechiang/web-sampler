/** Pure TypeScript PO-33 backup decoder. No Node, Web Audio, native or WASM calls.
 * Reference versions, licenses and interpretation limits: ../../decoder/README.md.
 */
import { decodePilotFrame } from "../../decoder/modem-pll.js?v=web-sampler-0.2.36";
import { parseWav } from "../../decoder/vendor/so-sample/wav.js?v=web-sampler-0.2.36";
import { parseFrame } from "../../decoder/vendor/so-sample/state.js?v=web-sampler-0.2.36";
import { decodeMulaw, SAMPLE_RATE } from "../../decoder/vendor/so-sample/mulaw.js?v=web-sampler-0.2.36";
import { readCell, readEffects } from "../../decoder/vendor/so-sample/pattern.js?v=web-sampler-0.2.36";
import { readChain, readSwing, readTempo } from "../../decoder/vendor/so-sample/globals.js?v=web-sampler-0.2.36";
import { TAG, decodeFrame } from "../../decoder/vendor/so-sample/packets.js?v=web-sampler-0.2.36";
export { encodePO33Backup, transferTimeline } from "./po33Encode.js?v=web-sampler-0.2.36";
/** Reject malformed/truncated RIFF rather than silently padding/truncating audio.
 * 16/24-bit integer PCM and 32-bit integer/float are supported for offline decoding.
 * This does not relax the separate raw PCM16 hardware replay page.
 */
function readWav(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength > 128 * 1024 * 1024 || bytes.length < 44)
        throw Error('Invalid or oversized backup WAV');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (p) => String.fromCharCode(...bytes.subarray(p, p + 4));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
        throw Error('Expected RIFF/WAVE');
    const end = view.getUint32(4, true) + 8;
    if (end < 44 || end > bytes.length)
        throw Error('Truncated RIFF data');
    let fmt = null, data = null;
    for (let p = 12; p < end;) {
        if (p + 8 > end)
            throw Error('Truncated WAV chunk header');
        const size = view.getUint32(p + 4, true), at = p + 8;
        if (at + size > end)
            throw Error('Truncated WAV chunk');
        if (tag(p) === 'fmt ') {
            if (fmt !== null || size < 16)
                throw Error('Invalid WAV fmt chunk');
            fmt = at;
        }
        if (tag(p) === 'data') {
            if (data !== null)
                throw Error('Multiple WAV data chunks');
            data = at;
        }
        p = at + size + (size & 1);
        if (p > end)
            throw Error('Missing WAV chunk padding');
    }
    if (fmt === null || data === null)
        throw Error('Missing WAV format or audio data');
    const code = view.getUint16(fmt, true), channels = view.getUint16(fmt + 2, true), rate = view.getUint32(fmt + 4, true);
    const bits = view.getUint16(fmt + 14, true), align = view.getUint16(fmt + 12, true), size = view.getUint32(data - 4, true);
    if (channels !== 2 || !([16, 24, 32].includes(bits)) || !(code === 1 || (code === 3 && bits === 32)))
        throw Error('Expected two-channel PCM16/24/32 or float32 backup WAV');
    if (align !== channels * bits / 8 || view.getUint32(fmt + 8, true) !== rate * align || size % align)
        throw Error('Invalid PCM layout');
    if (!size || rate < 32000 || rate > 192000 || size / align > rate * 600)
        throw Error('Unsupported backup duration/sample rate');
    const wav = parseWav(bytes.subarray(0, end));
    for (const c of wav.channels)
        for (const x of c)
            if (!Number.isFinite(x))
                throw Error('Non-finite audio sample');
    return wav;
}
export function parseWavStereo(wavBuffer) {
    const wav = readWav(wavBuffer);
    return { sampleRate: wav.sampleRate, numChannels: 2, leftChannel: Float32Array.from(wav.channels[0]), rightChannel: Float32Array.from(wav.channels[1]) };
}
function validatePcm(input) {
    if (!(input.left instanceof Float32Array) || !(input.right instanceof Float32Array) || input.left.length !== input.right.length || !input.left.length)
        throw Error('Two independent, equal-length PCM channels required');
    if (!Number.isInteger(input.sampleRate) || input.sampleRate < 32000 || input.sampleRate > 192000 || input.left.length > input.sampleRate * 600)
        throw Error('Unsupported PCM sample rate/duration');
    for (const c of [input.left, input.right])
        for (const x of c)
            if (!Number.isFinite(x))
                throw Error('Non-finite audio sample');
    return { sampleRate: input.sampleRate, channels: [Float64Array.from(input.left), Float64Array.from(input.right)], bitsPerSample: 32, format: 'float' };
}
function demodulate(wav, progress) {
    try {
        return { ...decodePilotFrame(wav, progress), channelOrder: 'normal' };
    }
    catch (normalError) {
        try {
            return { ...decodePilotFrame({ ...wav, channels: [wav.channels[1], wav.channels[0]] }, progress), channelOrder: 'swapped' };
        }
        catch (swappedError) {
            throw Error(`No complete checksum-valid PO-33 frame. Normal: ${normalError.message}; swapped: ${swappedError.message}`);
        }
    }
}
/** Returns only a complete frame whose every packet checksum has passed.
 * syncStartSample is the PLL probe coordinate of the first preamble symbol.
 * rawBytes includes the validated 4096-byte counter preamble and final packet.
 */
export function demodulateToBitstream(left, right, sampleRate) {
    const recovered = demodulate(validatePcm({ left, right, sampleRate }));
    return { syncStartSample: recovered.syncStartSample, rawBytes: recovered.wire, checksumErrors: 0 };
}
/** Decode without touching browser storage or the running sampler project. */
export function decodePO33Backup(wavOrPcm, options = {}) {
    const fromWav = wavOrPcm instanceof ArrayBuffer || wavOrPcm instanceof Uint8Array;
    const wav = fromWav ? readWav(wavOrPcm) : validatePcm(wavOrPcm);
    const recovered = demodulate(wav, options.onProgress);
    return projectFromFrame(recovered, wav.sampleRate, fromWav ? wav.bitsPerSample : null, options);
}
/** Decode a complete original transport frame without synthesizing/demodulating WAV. */
export function decodePO33Frame(wire) {
    if (wire.length < 4106 || wire.length > 8 * 1024 * 1024)
        throw Error('Invalid project frame size');
    for (let i = 0; i < 4096; i++)
        if (wire[i] !== (i < 4092 ? i & 255 : [0x4d, 0xb8, 0x16, 0x5d][i - 4092]))
            throw Error('Invalid project preamble');
    const frame = decodeFrame(wire, 4096);
    if (frame.endByte !== wire.length)
        throw Error('Trailing project frame bytes');
    return projectFromFrame({ frame, wire, syncStartSample: 0, channelOrder: 'normal' }, 0, null, {});
}
function projectFromFrame(recovered, inputSampleRate, inputBitsPerSample, options) {
    const state = parseFrame(recovered.frame);
    options.onProgress?.('validated', 1, 1);
    // Capture actual unwhitened payload bytes, not a re-encoded numeric header.
    const rawHeaders = new Map();
    let selectedRecord = -1;
    for (const packet of recovered.frame.packets) {
        if (packet.tag === TAG.SOUND_SELECT)
            selectedRecord = packet.payload[0];
        else if (packet.tag === TAG.SOUND_DATA && !rawHeaders.has(selectedRecord))
            rawHeaders.set(selectedRecord, packet.payload.slice(0, 9));
    }
    const sliceDiagnostics = [];
    const rangeWarnings = [];
    const pools = [], byId = new Map();
    state.sounds.forEach((r, id) => {
        if (!r?.codes.length)
            return;
        const audioBuffer = Float32Array.from(r.codes, decodeMulaw);
        const pool = { id, codes: r.codes, audioBuffer, sampleRate: SAMPLE_RATE };
        pools.push(pool);
        byId.set(id, pool);
    });
    const clip = (recordId) => {
        const r = state.sounds[recordId];
        if (!r)
            return null;
        const pool = byId.get(r.owner);
        if (!pool)
            throw Error(`Sound record ${recordId} refers to missing pool ${r.owner}`);
        if (r.end < r.start)
            throw Error(`Sound record ${recordId} has a reversed range`);
        const status = r.end > pool.audioBuffer.length ? 'out-of-pool' : 'complete';
        if (status === 'out-of-pool') {
            const diagnostic = {
                slotId: recordId < 8 ? recordId + 1 : 9 + Math.floor((recordId - 8) / 16),
                slotType: recordId < 8 ? 'melodic' : 'drum',
                padIndex: recordId < 8 ? null : (recordId - 8) % 16,
                recordId,
                rawHex: Array.from(rawHeaders.get(recordId) ?? [], x => x.toString(16).padStart(2, '0').toUpperCase()).join(' '),
                sourcePoolId: r.owner, startSample: r.start, endSample: r.end,
                bufferLength: pool.audioBuffer.length, encodedByteLength: pool.codes.length
            };
            sliceDiagnostics.push(diagnostic);
            options.onSliceDiagnostic?.({ ...diagnostic });
            rangeWarnings.push(`Sound record ${recordId}: raw range ${r.start}..${r.end} exceeds received pool ${r.owner} (${pool.audioBuffer.length} codes). Raw coordinates retained; preview contains only available PCM. No zero padding or cross-pool addressing is invented.`);
        }
        return { audioBuffer: pool.audioBuffer.subarray(r.start, r.end), poolId: r.owner, start: r.start, end: r.end, status };
    };
    const slots = Array.from({ length: 16 }, (_, index) => {
        const id = index + 1;
        if (id <= 8) {
            const c = clip(index);
            return { id, type: 'melodic', sampleRate: SAMPLE_RATE, audioBuffer: c?.audioBuffer ?? null, slices: c ? [{ startSample: 0, endSample: c.audioBuffer.length, pitch: 0, volume: 100, filterType: 'none', filterFreq: 0, resonance: 0, parameterSource: 'preview-defaults', recordId: index, sourcePoolId: c.poolId, sourceStartSample: c.start, sourceEndSample: c.end, audioBuffer: c.audioBuffer, rangeStatus: c.status }] : [] };
        }
        let length = 0;
        const slices = Array.from({ length: 16 }, (_, key) => {
            const recordId = 8 + 16 * (id - 9) + key, c = clip(recordId), startSample = length;
            length += c?.audioBuffer.length ?? 0;
            return { startSample, endSample: length, pitch: 0, volume: 100, filterType: 'none', filterFreq: 0, resonance: 0, parameterSource: 'preview-defaults', recordId, sourcePoolId: c?.poolId ?? null, sourceStartSample: c?.start ?? 0, sourceEndSample: c?.end ?? 0, audioBuffer: c?.audioBuffer ?? null, rangeStatus: c?.status ?? 'empty' };
        });
        const audioBuffer = slices.some(s => s.audioBuffer !== null) ? new Float32Array(length) : null;
        if (audioBuffer)
            for (const s of slices)
                if (s.audioBuffer)
                    audioBuffer.set(s.audioBuffer, s.startSample);
        return { id, type: 'drum', sampleRate: SAMPLE_RATE, audioBuffer, slices };
    });
    const patterns = state.patterns.map((raw, index) => {
        const effects = readEffects(raw);
        return { id: index + 1, raw, steps: Array.from({ length: 16 }, (_, stepIndex) => {
                const triggers = [], parameterOnly = [];
                for (let slotId = 1; slotId <= 16; slotId++) {
                    const cell = readCell(raw, stepIndex + 1, slotId);
                    if (!cell)
                        continue;
                    const at = 48 * stepIndex + 3 * (slotId - 1), word = raw[at] | (raw[at + 1] << 8) | (raw[at + 2] << 16);
                    const controlRaw = raw[768 + 16 * stepIndex + slotId - 1], timingRaw = controlRaw >> 4;
                    const paramLocks = {};
                    for (const key of ['pitch', 'volume', 'filter', 'resonance'])
                        if (cell[key])
                            paramLocks[key + 'Code'] = cell[key];
                    if (cell.bit5)
                        paramLocks.bit5 = cell.bit5;
                    if (cell.key === null) {
                        parameterOnly.push({ slotId, paramLocks, parameterWordRaw: word });
                        continue;
                    }
                    triggers.push({ slotId, sliceOrNote: cell.key - 1, paramLocks, parameterWordRaw: word, controlRaw, timingRaw, lengthSteps: slotId <= 8 && timingRaw !== 15 ? timingRaw : null, retriggers: slotId <= 8 ? 1 : (timingRaw === 5 ? 6 : timingRaw === 7 ? 8 : timingRaw) });
                }
                return { stepIndex, triggers, parameterOnly, fx: effects[stepIndex], fxCodeRaw: (raw[1024 + (stepIndex >> 1)] >> ((stepIndex & 1) ? 0 : 4)) & 15 };
            }) };
    });
    const bpm = readTempo(state.globals[1]), swingRaw = readSwing(state.globals[1]), patternChain = readChain(state.globals[1]);
    if (bpm < 60 || bpm > 240)
        throw Error('Out-of-range hardware BPM');
    return { sliceDiagnostics, meta: { bpm, swing: swingRaw / 18 * 100, masterVolume: 16, swingRaw, defaultedFields: ['masterVolume'] }, slots, patterns, patternChain, pools, raw: { state, frameBytes: recovered.wire },
        validation: { checksumErrors: 0, packetCount: recovered.frame.packets.length, complete: true, syncStartSample: recovered.syncStartSample, inputSampleRate, inputBitsPerSample, channelOrder: recovered.channelOrder, unresolvedAudioRanges: rangeWarnings.length },
        warnings: [...rangeWarnings, 'masterVolume is an explicit unity audition default; not recovered from a verified hardware field.', 'Slice pitch/volume/filter values are audition defaults. Pattern locks retain raw hardware codes; no unverified Hz/gain conversion is applied.', 'Drum audioBuffer concatenates slice previews; shared hardware allocation remains in pools/raw.state. Capacity must count unique pools, not previews.'] };
}
