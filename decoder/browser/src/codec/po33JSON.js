/** Versioned lossless binary JSON. Float samples are bytes, never decimal text. */
import { bytesToBase64, base64ToBytes } from "../../decoder/vendor/so-sample/bytes.js?v=web-sampler-0.2.34";
import { decodePO33Frame } from "./po33Codec.js?v=web-sampler-0.2.34";
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function floatBytes(array) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice();
    if (!littleEndian)
        for (let i = 0; i < bytes.length; i += 4)
            bytes.subarray(i, i + 4).reverse();
    return bytes;
}
export function projectToJSON(project) {
    return JSON.stringify({ format: 'po33-project', version: 1, project }, (_key, value) => {
        if (value instanceof Uint8Array)
            return { $po33: 'u8', base64: bytesToBase64(value) };
        if (value instanceof Float32Array)
            return { $po33: 'f32le', base64: bytesToBase64(floatBytes(value)) };
        return value;
    });
}
export function projectFromJSON(text) {
    if (text.length > 128 * 1024 * 1024)
        throw Error('Project JSON exceeds 128 MB');
    const document = JSON.parse(text, (_key, value) => {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, '$po33'))
            return value;
        if (!['u8', 'f32le'].includes(value.$po33) || typeof value.base64 !== 'string' || value.base64.length > 64 * 1024 * 1024 || value.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64))
            throw Error('Invalid binary JSON field');
        const bytes = base64ToBytes(value.base64);
        if (value.$po33 === 'u8')
            return bytes;
        if (bytes.length % 4)
            throw Error('Invalid Float32 byte count');
        if (!littleEndian)
            for (let i = 0; i < bytes.length; i += 4)
                bytes.subarray(i, i + 4).reverse();
        return new Float32Array(bytes.buffer);
    });
    const source = document.format === 'po33-project' && document.version === 1 ? document.project : document;
    let wire = source?.raw?.frameBytes;
    // Also accept a full PO33Project whose Uint8Array was serialized as a
    // numeric object by ordinary JSON.stringify, while deriving audio afresh.
    if (!(wire instanceof Uint8Array)) {
        if (!wire || typeof wire !== 'object' || Object.keys(wire).length > 8 * 1024 * 1024)
            throw Error('JSON needs raw.frameBytes from a PO33Project');
        const values = Array.isArray(wire) ? wire : Object.keys(wire).map((key, i) => { if (key !== String(i))
            throw Error('Invalid frame byte indices'); return wire[key]; });
        if (!values.every((v) => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 255))
            throw Error('Invalid frame byte values');
        wire = Uint8Array.from(values);
    }
    const validated = decodePO33Frame(wire);
    // For our binary format verify stored PCM and codes against the checked
    // native frame. Never silently accept an edited preview with stale bytes.
    if (document.format === 'po33-project') {
        if (!Array.isArray(source.pools) || source.pools.length !== validated.pools.length)
            throw Error('JSON sample pools do not match native frame');
        for (const expected of validated.pools) {
            const pool = source.pools.find((p) => p.id === expected.id);
            if (!(pool?.audioBuffer instanceof Float32Array) || !(pool?.codes instanceof Uint8Array))
                throw Error('Missing binary sample pool');
            const a = floatBytes(pool.audioBuffer), b = floatBytes(expected.audioBuffer);
            if (a.length !== b.length || !a.every((v, i) => v === b[i]) || pool.codes.length !== expected.codes.length || !pool.codes.every((v, i) => v === expected.codes[i]))
                throw Error('JSON audio differs from native frame; recompile edits before exporting');
        }
    }
    return validated;
}
