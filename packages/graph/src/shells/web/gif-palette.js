/* Shared by playback.js and the GIF worker. A persistent RGB565 lookup avoids
   gifenc's per-frame palette-distance scan for colors already seen. */
function rgb565Key(red,green,blue){
  return ((red<<8)&0xf800)|((green<<2)&0x03e0)|(blue>>3);
}

function nearestPaletteIndex(red,green,blue,palette){
  let nearest=0;
  let minimumDistance=Number.POSITIVE_INFINITY;
  for(let index=0;index<palette.length;index+=1){
    const color=palette[index];
    const redDistance=color[0]-red;
    const greenDistance=color[1]-green;
    const blueDistance=color[2]-blue;
    const distance=redDistance*redDistance+greenDistance*greenDistance+blueDistance*blueDistance;
    if(distance<minimumDistance){
      minimumDistance=distance;
      nearest=index;
    }
  }
  return nearest;
}

export function createRgb565PaletteMapper(palette){
  if(!palette.length||palette.length>256)
    throw new Error("GIF palette must contain between 1 and 256 colors");
  const lookup=new Int16Array(65536);
  lookup.fill(-1);

  return rgba=>{
    const pixels=new Uint32Array(rgba.buffer,rgba.byteOffset,rgba.byteLength/4);
    const indexed=new Uint8Array(pixels.length);
    for(let index=0;index<pixels.length;index+=1){
      const pixel=pixels[index];
      const red=pixel&0xff;
      const green=(pixel>>8)&0xff;
      const blue=(pixel>>16)&0xff;
      const key=rgb565Key(red,green,blue);
      let paletteIndex=lookup[key];
      if(paletteIndex<0){
        paletteIndex=nearestPaletteIndex(red,green,blue,palette);
        lookup[key]=paletteIndex;
      }
      indexed[index]=paletteIndex;
    }
    return indexed;
  };
}
