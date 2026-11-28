var global=globalThis;
importScripts('./vendor/alac/alac-bundle.js?v=web-sampler-0.2.37');
// Demux packet tables directly, including iOS Voice Memos' 64-bit mdat atoms.
self.onmessage=({data:{buffer,sampleRate}})=>{
 try{
  const view=new DataView(buffer),bytes=new Uint8Array(buffer),text=(p,n)=>String.fromCharCode(...bytes.subarray(p,p+n));
  function boxes(start,end){const out=[];for(let p=start;p+8<=end;){let n=view.getUint32(p),head=8;if(n===1){n=view.getUint32(p+8)*4294967296+view.getUint32(p+12);head=16;}if(n===0)n=end-p;if(!Number.isSafeInteger(n)||n<head||p+n>end)throw Error('Invalid M4A atom');out.push({type:text(p+4,4),start:p+head,end:p+n});p+=n;}return out;}
  function child(parent,type){const b=boxes(parent.start,parent.end).find(b=>b.type===type);if(!b)throw Error('M4A missing '+type);return b;}
  const moov=child({start:0,end:bytes.length},'moov');let media;
  for(const track of boxes(moov.start,moov.end).filter(b=>b.type==='trak')){const m=child(track,'mdia'),h=child(m,'hdlr');if(text(h.start+8,4)==='soun'){media=m;break;}}
  if(!media)throw Error('M4A has no audio track');
  const table=child(child(media,'minf'),'stbl'),description=child(table,'stsd'),entry=boxes(description.start+8,description.end)[0];
  if(entry.type!=='alac')throw Error('This browser cannot decode this M4A codec; use lossless ALAC or stereo PCM WAV');
  const version=view.getUint16(entry.start+8),extensions=entry.start+28+(version===1?16:0),cookie=child({start:extensions,end:entry.end},'alac');
  const config=bytes.slice(cookie.start+4,cookie.end),format={bitsPerChannel:config[5],channelsPerFrame:config[9],sampleRate};
  if(format.channelsPerFrame!==2)throw Error('PO-33 backup requires two independent stereo channels');
  if(![16,24].includes(format.bitsPerChannel))throw Error('ALAC supports 16-bit or 24-bit backup recordings');
  const Decoder=PO33ALAC.Decoder.find('alac'),decoder=new Decoder({on(){}},format);decoder.setCookie(new PO33ALAC.Buffer(config));
  const sizesAtom=child(table,'stsz'),fixed=view.getUint32(sizesAtom.start+4),count=view.getUint32(sizesAtom.start+8),sizes=[];
  if(count>1000000 || (!fixed && sizesAtom.start+12+count*4>sizesAtom.end))throw Error('Invalid M4A packet table');
  for(let i=0;i<count;i++)sizes.push(fixed||view.getUint32(sizesAtom.start+12+i*4));
  const entries=boxes(table.start,table.end),offsetsAtom=entries.find(b=>b.type==='stco'||b.type==='co64');if(!offsetsAtom)throw Error('Missing M4A chunk offsets');
  const chunks=view.getUint32(offsetsAtom.start+4),offsets=[];
  for(let i=0;i<chunks;i++){const p=offsetsAtom.start+8+i*(offsetsAtom.type==='co64'?8:4);offsets.push(offsetsAtom.type==='co64'?view.getUint32(p)*4294967296+view.getUint32(p+4):view.getUint32(p));}
  const stsc=child(table,'stsc'),mapping=[];
  for(let i=0;i<view.getUint32(stsc.start+4);i++){const p=stsc.start+8+i*12;mapping.push({first:view.getUint32(p),count:view.getUint32(p+4)});}
  const parts=[];let packet=0,map=0,frames=0;
  for(let chunk=0;chunk<chunks;chunk++){
   while(map+1<mapping.length && mapping[map+1].first<=chunk+1)map++;
   let offset=offsets[chunk];
   for(let j=0;j<mapping[map].count && packet<count;j++,packet++){
    const size=sizes[packet];if(offset<0||offset+size>bytes.length)throw Error('M4A packet outside file');
    const padded=new Uint8Array(size+8);padded.set(bytes.subarray(offset,offset+size));offset+=size;
    decoder.stream=PO33ALAC.Stream.fromBuffer(new PO33ALAC.Buffer(padded));decoder.bitstream=new PO33ALAC.Bitstream(decoder.stream);
    const output=decoder.readChunk();if(!output||output.length%2)throw Error('Invalid ALAC frame');parts.push(output);frames+=output.length/2;
   }
  }
  if(packet!==count)throw Error('Incomplete M4A packet table');
  const left=new Float32Array(frames),right=new Float32Array(frames),scale=Math.pow(2,format.bitsPerChannel-1);let at=0;
  for(const part of parts)for(let i=0;i<part.length;i+=2){left[at]=part[i]/scale;right[at++]=part[i+1]/scale;}
  self.postMessage({pcm:{left,right,sampleRate}},[left.buffer,right.buffer]);
 }catch(error){self.postMessage({error:error.message});}
};
