/* Local QR scanner, camera lifecycle and URL fallback. */
(function(root){'use strict';
  function create(parent){
    // A regular body-level overlay is more reliable than <dialog> fullscreen in
    // embedded Creation WebViews, which can report a viewport smaller than the screen.
    const dialog=document.createElement('section');dialog.id='transferQR';dialog.className='qr-camera-overlay';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Scan project QR');dialog.hidden=true;
    dialog.innerHTML='<header><p>Scan QR / 扫描二维码</p><p id="transferQRStatus" role="status">Opening camera / 正在打开摄像头…</p></header><video id="transferQRVideo" autoplay muted playsinline></video><form id="transferQRForm"><button id="transferQRURLToggle" type="button" aria-expanded="false">Enter URL / 输入网址</button><label id="transferQRURLLabel" hidden>WAV URL / 下载网址<input id="transferQRURL" type="url" inputmode="url" autocomplete="off" placeholder="https://…/backup.wav"></label><button id="transferQRImport" type="submit" hidden>Import URL / 导入网址</button><button id="transferQRCancel" type="button">Cancel / 取消</button></form>';
    document.body.append(dialog);
    const video=dialog.querySelector('video'),status=dialog.querySelector('#transferQRStatus'),input=dialog.querySelector('input');
    let stream=null,worker=null,timer=null,finish=null,session=0,busy=false,receiver=null,assembler=null,pairing=false;
    function cleanup(){clearTimeout(timer);timer=null;if(worker)worker.terminate();worker=null;if(stream)stream.getTracks().forEach(t=>{t.onended=null;t.stop();});stream=null;video.srcObject=null;busy=false;}
    function settle(text){root.dispatchEvent(new CustomEvent('po33-scan-state',{detail:{active:false}}));session++;cleanup();dialog.hidden=true;document.body.classList.remove('scanner-open');const resolve=finish;finish=null;resolve?.(text);}
    const urlToggle=dialog.querySelector('#transferQRURLToggle'),urlLabel=dialog.querySelector('#transferQRURLLabel'),urlImport=dialog.querySelector('#transferQRImport');
    urlToggle.onclick=()=>{const expanded=urlToggle.getAttribute('aria-expanded')!=='true';urlToggle.setAttribute('aria-expanded',String(expanded));urlLabel.hidden=!expanded;urlImport.hidden=!expanded;if(expanded)input.focus({preventScroll:true});};
    dialog.querySelector('#transferQRCancel').onclick=()=>settle(null);
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&finish){e.preventDefault();settle(null);}});
    dialog.querySelector('form').onsubmit=e=>{e.preventDefault();if(input.value.trim())settle(input.value.trim());};
    document.addEventListener('visibilitychange',()=>{if(document.hidden && finish)settle(null);});
    async function camera(token){
      try{
        if(!root.isSecureContext)throw Error('Camera requires HTTPS or localhost');
        if(!navigator.mediaDevices?.getUserMedia)throw Error('Camera API unavailable');
        const portrait=(root.visualViewport?.height||root.innerHeight)>=(root.visualViewport?.width||root.innerWidth);const acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:portrait?720:1280},height:{ideal:portrait?1280:720},frameRate:{ideal:30,max:30}}});
        if(token!==session){acquired.getTracks().forEach(t=>t.stop());return;}
        stream=acquired;stream.getVideoTracks().forEach(t=>{t.onended=()=>{cleanup();status.textContent='Camera disconnected. Paste URL or reopen scanner / 摄像头已断开，可输入网址。';};});
        video.setAttribute('webkit-playsinline','');video.disablePictureInPicture=true;video.srcObject=stream;await video.play();if(token!==session || !stream)return;
        worker=new Worker((root.PO33_RESOURCE?root.PO33_RESOURCE('./qr-camera-worker.js'):'./qr-camera-worker.js'));
        worker.onerror=()=>{cleanup();status.textContent='QR decoder unavailable. Paste URL below / 扫码不可用，请输入网址。';};
        worker.onmessage=async({data:m})=>{
          if(token!==session)return;
          if(m.error){busy=false;cleanup();status.textContent=m.error;return;}
          if(!m.text){busy=false;return;}
          try{
            if(token!==session)return;
            if(pairing && assembler){const frame=assembler.add(m.text);if(frame.complete){status.textContent='Pairing code complete / 配对码已收齐';settle(frame.text);}else if(!frame.ignored){status.textContent=`Pairing frames ${frame.received}/${frame.total} · keep camera steady / 配对帧 ${frame.received}/${frame.total}，请保持取景稳定`;}else status.textContent='Scan the animated pairing QR / 请扫描动态配对二维码';return;}
            status.textContent='Download QR detected · opening project… / 已识别下载码，正在打开工程…';settle(m.text);
          }catch(error){status.textContent=error.message+' Try another download QR or paste its URL. / 请重试下载二维码或粘贴网址。';}
          finally{busy=false;}
        };
        const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true});
        if(!context)throw Error('Camera image access unavailable');
        status.textContent='Hold the full QR steady in frame / 请将完整二维码对准并保持稳定';
        function frame(){
          if(token!==session || !worker)return;
          timer=setTimeout(frame,100);
          if(busy || video.readyState<2 || !video.videoWidth)return;
          const scale=Math.min(1,960/Math.max(video.videoWidth,video.videoHeight));
          canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
          try{context.drawImage(video,0,0,canvas.width,canvas.height);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;busy=true;worker.postMessage({width:canvas.width,height:canvas.height,pixels:pixels.buffer},[pixels.buffer]);}
          catch(error){cleanup();status.textContent='Camera frame access failed. Paste URL / 无法读取画面，请输入网址。';}
        }
        frame();
      }catch(error){if(token!==session)return;cleanup();status.textContent=`${error.name || 'Camera'}: ${error.message || 'Unavailable'}. Paste URL below / 可在下方输入网址。`;}
    }
    return {get active(){return !!finish;},close:()=>settle(null),
      open(options={}){if(finish)settle(null);pairing=options.pairing===true;assembler=pairing?root.PO33PeerTransfer?.createSignalAssembler():null;root.dispatchEvent(new CustomEvent('po33-scan-state',{detail:{active:true}}));const token=++session;input.value='';urlToggle.setAttribute('aria-expanded','false');urlLabel.hidden=urlImport.hidden=true;status.textContent=pairing?'Scan the animated pairing QR / 请扫描动态配对二维码':'Opening camera / 正在打开摄像头…';dialog.hidden=false;document.body.classList.add('scanner-open');dialog.querySelector('#transferQRCancel').focus({preventScroll:true});const result=new Promise(resolve=>{finish=resolve;});camera(token);return result;}
    };
  }
  root.PO33QRCamera={create};
})(window);
