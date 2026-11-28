import './tone.js?v=web-sampler-0.2.34';
class PO33HardwareTone extends AudioWorkletProcessor {
 constructor(){super();this.engines=[];}
 process(inputs,outputs){const source=inputs[0] || [];for(let channel=0;channel<outputs[0].length;channel++){if(channel>0 && !source[channel]){outputs[0][channel].set(outputs[0][0]);continue;}if(!this.engines[channel])this.engines[channel]=new globalThis.PO33Tone.Tone(sampleRate);const output=outputs[0][channel],input=source[channel] || source[0];if(input)this.engines[channel].process(input,output);else output.fill(0);}return true;}
}
registerProcessor('po33-hardware-tone',PO33HardwareTone);
