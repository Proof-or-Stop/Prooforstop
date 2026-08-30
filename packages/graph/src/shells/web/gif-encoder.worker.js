import {GIFEncoder} from "./gifenc.esm.js";
import {createRgb565PaletteMapper} from "./gif-palette.js";

let encoder=null;
let mapPalette=null;
let width=0;
let height=0;
let frameCount=0;
let delay=0;
let palette=[];

self.onmessage=event=>{
  try{
    const message=event.data;
    if(message.type==="initialize"){
      width=message.width;
      height=message.height;
      frameCount=message.frameCount;
      delay=message.delay;
      palette=message.palette;
      mapPalette=createRgb565PaletteMapper(palette);
      encoder=GIFEncoder({initialCapacity:message.initialCapacity});
      return;
    }
    if(!encoder||!mapPalette) throw new Error("GIF encoder worker was not initialized");
    const indexed=mapPalette(new Uint8ClampedArray(message.rgba));
    encoder.writeFrame(indexed,width,height,
      {palette:message.index===0?palette:undefined,delay,repeat:0});
    self.postMessage({type:"encoded",index:message.index});

    if(message.index===frameCount-1){
      encoder.finish();
      const bytes=encoder.bytes();
      const buffer=bytes.buffer;
      self.postMessage({type:"done",bytes:buffer},[buffer]);
    }
  }catch(error){
    self.postMessage({type:"error",message:error instanceof Error?error.message:String(error)});
  }
};
