// Decodes camera pixels locally. No camera frame leaves the device.
importScripts('./vendor/jsqr/jsQR.js?v=web-sampler-0.2.35');
self.onmessage=({data:m})=>{
  try{
    const code=self.jsQR(new Uint8ClampedArray(m.pixels),m.width,m.height,{inversionAttempts:'attemptBoth'});
    self.postMessage({text:code?.data || ''});
  }catch(error){self.postMessage({error:error.message});}
};
