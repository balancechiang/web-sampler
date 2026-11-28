import { decodeFrame } from "./vendor/so-sample/packets.js?v=web-sampler-0.2.33";
function biquad(cutoff, rate, q, highpass) {
    const k = Math.tan(Math.PI * cutoff / rate), norm = 1 / (1 + k / q + k * k), b0 = (highpass ? 1 : k * k) * norm;
    return { b0, b1: (highpass ? -2 : 2) * b0, b2: b0, a1: 2 * (k * k - 1) * norm, a2: (1 - k / q + k * k) * norm };
}
function firstOrder(cutoff, rate) {
    const k = Math.tan(Math.PI * cutoff / rate), b0 = k / (1 + k);
    return { b0, b1: b0, b2: 0, a1: (k - 1) / (k + 1), a2: 0 };
}
function zeroPhase(data, f) {
    for (const reverse of [false, true]) {
        let z1 = 0, z2 = 0;
        for (let j = 0; j < data.length; j++) {
            const i = reverse ? data.length - 1 - j : j, input = data[i], output = f.b0 * input + z1;
            z1 = f.b1 * input - f.a1 * output + z2;
            z2 = f.b2 * input - f.a2 * output;
            data[i] = output;
        }
    }
}
function interpolate(x, t) {
    const i = Math.floor(t), u = t - i, a = x[i - 1], b = x[i], c = x[i + 1], d = x[i + 2];
    return b + .5 * u * (c - a + u * (2 * a - 5 * b + 4 * c - d + u * (3 * (b - c) + d - a)));
}
export function decodePilotFrame(wav, progress) {
    const rate = wav.sampleRate, n = wav.channels[0].length, frequency = 7812.5;
    if (n < 8192 || wav.channels.length !== 2)
        throw Error('Insufficient stereo samples for pilot acquisition');
    const x = wav.channels.map(c => c.slice()), pilot = [new Float64Array(n), new Float64Array(n)];
    const hp = biquad(200, rate, Math.SQRT1_2, true), lp1 = firstOrder(3, rate), lp2 = biquad(3, rate, 1, false);
    for (const channel of x)
        zeroPhase(channel, hp);
    progress?.('filter', 1, 1);
    const step = 2 * Math.PI * frequency / rate, cs = Math.cos(step), sn = Math.sin(step);
    let oscR = 1, oscI = 0;
    for (let i = 0; i < n; i++) {
        const power = (x[0][i] * x[0][i] + x[1][i] * x[1][i]) * .5, next = oscR * cs - oscI * sn;
        pilot[0][i] = power * oscR;
        pilot[1][i] = -power * oscI;
        oscI = oscI * cs + oscR * sn;
        oscR = next;
        if ((i & 4095) === 4095) {
            const magnitude = Math.hypot(oscR, oscI);
            oscR /= magnitude;
            oscI /= magnitude;
        }
    }
    for (const channel of pilot) {
        zeroPhase(channel, lp1);
        zeroPhase(channel, lp2);
    }
    progress?.('clock', 1, 1);
    const nibbles = new Uint8Array(Math.ceil(n * frequency / rate) + 16), previous = [0, 0], eighth = rate / (frequency * 8);
    const samplePositions = new Float64Array(nibbles.length);
    let lastAngle = 0, unwrapped = 0, lastClock = 0, havePrevious = false, count = 0;
    for (let i = 0; i < n; i++) {
        if ((i & 65535) === 0)
            progress?.('demodulate', i, n);
        const angle = Math.atan2(pilot[1][i], pilot[0][i]);
        let delta = angle - lastAngle;
        if (delta > Math.PI)
            delta -= 2 * Math.PI;
        else if (delta < -Math.PI)
            delta += 2 * Math.PI;
        unwrapped += delta;
        lastAngle = angle;
        const clock = i * frequency / rate + unwrapped / (2 * Math.PI);
        if (i && Math.floor(clock) > Math.floor(lastClock) && clock - lastClock < 1) {
            const t = i - 1 + (Math.floor(clock) - lastClock) / (clock - lastClock);
            if (t - eighth >= 1 && t + eighth < n - 3) {
                let nibble = 0;
                for (let ch = 0; ch < 2; ch++) {
                    const phase = Math.atan2(interpolate(x[ch], t + eighth), interpolate(x[ch], t - eighth));
                    const difference = (previous[ch] - phase) * 2 / Math.PI;
                    const d = Math.trunc(difference < 0 ? difference - .5 : difference + .5) & 3;
                    nibble |= d << (ch === 0 ? 2 : 0);
                    previous[ch] = phase;
                }
                if (havePrevious) {
                    if (count >= nibbles.length)
                        throw Error('Pilot clock produced excess symbols');
                    samplePositions[count] = t;
                    nibbles[count++] = nibble;
                }
                havePrevious = true;
            }
        }
        lastClock = clock;
    }
    const packed = (start, index) => nibbles[start + 2 * index] | (nibbles[start + 2 * index + 1] << 4);
    let lastError = 'No counter preamble found';
    for (let start = 0; start + 8192 <= count; start++) {
        if (packed(start, 4092) !== 0x4d || packed(start, 4093) !== 0xb8 || packed(start, 4094) !== 0x16 || packed(start, 4095) !== 0x5d)
            continue;
        let match = true;
        for (let j = 0; j < 4092; j++)
            if (packed(start, j) !== (j & 255)) {
                match = false;
                break;
            }
        if (!match)
            continue;
        const wire = new Uint8Array(Math.floor((count - start) / 2));
        for (let j = 0; j < wire.length; j++)
            wire[j] = packed(start, j);
        try {
            const frame = decodeFrame(wire, 4096);
            return { frame, wire: wire.slice(0, frame.endByte), syncStartSample: Math.floor(samplePositions[start]) };
        }
        catch (error) {
            lastError = error.message;
        }
    }
    throw Error('Pilot recovery failed: ' + lastError);
}
