import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {MirrorError} from './errors.js';
import {mediaType,MAX_MEDIA_BYTES} from './drive-media.js';
export const variantPresets:Record<string,[number,number]>={square:[1080,1080],portrait:[1080,1350],vertical:[1080,1920],landscape:[1920,1080]};
let active=0;
export async function runMediaProcess(binary:string,args:string[],timeout=45000):Promise<string>{
 return new Promise((resolve,reject)=>{let output='',finished=false;const child=spawn(binary,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const done=(e?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);if(e)reject(e);else resolve(output);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');done(new MirrorError('MEDIA_CONVERSION_TIMEOUT','Media conversion exceeded its time limit.'));},timeout);
  child.stdout.on('data',b=>{output+=b.toString();if(output.length>1024*1024){child.kill('SIGKILL');done(new MirrorError('MEDIA_CONVERSION_FAILED','Media metadata exceeded its limit.'));}});child.stderr.on('data',()=>{});
  child.on('error',()=>done(new MirrorError('MEDIA_PROCESSOR_UNAVAILABLE','Install FFmpeg and ffprobe, or configure AMCP_FFMPEG_PATH and AMCP_FFPROBE_PATH.')));child.on('close',code=>done(code===0?undefined:new MirrorError('MEDIA_CONVERSION_FAILED','The media could not be decoded or converted.')));
 });
}
/** Geometry checks against the user's chosen preset; this is not provider policy approval. */
export async function inspectMediaPlacement(bytes:Buffer,preset:string){
 if(!Object.hasOwn(variantPresets,preset))throw new MirrorError('INVALID_VARIANT','Choose square, portrait, vertical or landscape.');
 if(bytes.length>MAX_MEDIA_BYTES||active>=2)throw new MirrorError('MEDIA_PROCESSOR_BUSY','Media inspection is currently at capacity.');
 active++;let directory:string|undefined;
 try{
  const type=mediaType(bytes);directory=await fs.mkdtemp(path.join(os.tmpdir(),'amcp-variant-'));const input=path.join(directory,'input.'+type.extension);await fs.writeFile(input,bytes,{mode:0o600});
  const demuxer=type.kind==='video'?'mov':type.extension==='png'?'png_pipe':'jpeg_pipe';
  const data=JSON.parse(await runMediaProcess(process.env.AMCP_FFPROBE_PATH??'ffprobe',['-v','error','-max_alloc','134217728','-protocol_whitelist','file,pipe','-f',demuxer,...(demuxer==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[]),'-show_streams','-show_format','-of','json',input],15000));
  const streams=data.streams?.filter((s:any)=>s.codec_type==='video'),video=streams?.[0];if(streams?.length!==1||!video.width||!video.height||video.width*video.height>40000000)throw new MirrorError('MEDIA_DIMENSIONS_UNSUPPORTED','Use one decodable image/video stream of at most 40 megapixels.');
  const rotation=Number(video.side_data_list?.find((s:any)=>s.rotation!==undefined)?.rotation??video.tags?.rotate??0);if(rotation%90)throw new MirrorError('MEDIA_ROTATION_UNSUPPORTED','Normalize this media’s rotation before upload.');const swapped=Math.abs(rotation)%180===90,width=swapped?video.height:video.width,height=swapped?video.width:video.height,duration=type.kind==='video'?Number(data.format?.duration??video.duration):null;
  if(duration!==null&&(!Number.isFinite(duration)||duration<=0||duration>180))throw new MirrorError('MEDIA_DIMENSIONS_UNSUPPORTED','This bounded inspection supports videos up to 180 seconds.');
  const [targetWidth,targetHeight]=variantPresets[preset]!,checks=[{name:'aspect_ratio',passed:Math.abs(width/height-targetWidth/targetHeight)<0.005,actual:width+':'+height,target:targetWidth+':'+targetHeight},{name:'minimum_resolution',passed:width>=targetWidth&&height>=targetHeight,actual:width+'×'+height,target:targetWidth+'×'+targetHeight},...(type.kind==='video'?[{name:'widely_supported_video_codec',passed:video.codec_name==='h264',actual:video.codec_name,target:'h264'}]:[])];
  return {width,height,duration,codec:video.codec_name,preset,checks,eligible_for_preset:checks.every(c=>c.passed),provider_approved:false,meaning:'AMCP geometry and codec checks only. Provider placement, policy and account acceptance are verified separately.',...(!checks.every(c=>c.passed)?{next_step:'Create a reviewed variant for this preset or supply a higher-resolution source.'}:{})};
 }finally{active--;if(directory){if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('amcp-variant-'))throw Error('Invalid media temporary directory');await fs.rm(directory,{recursive:true,force:true});}}
}
export async function createMediaVariant(bytes:Buffer,preset:string,fit='contain'){
 if(!Object.hasOwn(variantPresets,preset)||!['contain','crop'].includes(fit))throw new MirrorError('INVALID_VARIANT','Choose square, portrait, vertical or landscape, with contain or crop.');
 if(bytes.length>MAX_MEDIA_BYTES||active>=2)throw new MirrorError('MEDIA_PROCESSOR_BUSY','At most two bounded media conversions may run concurrently.');
 const type=mediaType(bytes),[width,height]=variantPresets[preset]!;active++;let directory:string|undefined;
 try{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'amcp-variant-'));const input=path.join(directory,'input.'+type.extension),output=path.join(directory,type.kind==='image'?'output.png':'output.mp4');await fs.writeFile(input,bytes,{mode:0o600});
  const demuxer=type.kind==='video'?'mov':type.extension==='png'?'png_pipe':'jpeg_pipe';
  const guard=['-max_alloc','134217728','-protocol_whitelist','file,pipe','-f',demuxer,...(demuxer==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[])];
  const metadata=JSON.parse(await runMediaProcess(process.env.AMCP_FFPROBE_PATH??'ffprobe',['-v','error',...guard,'-show_streams','-show_format','-of','json',input],15000));
  const videos=metadata.streams?.filter((s:any)=>s.codec_type==='video'),video=videos?.[0],duration=Number(metadata.format?.duration??video?.duration);
  // ffprobe versions differ on malformed images: some exit nonzero, others return a zero-sized stream.
  if(!videos?.length||!Number.isInteger(video.width)||!Number.isInteger(video.height)||video.width<1||video.height<1)throw new MirrorError('MEDIA_CONVERSION_FAILED','The media could not be decoded or converted.');
  if(videos.length!==1||video.width*video.height>40000000||type.kind==='video'&&(!Number.isFinite(duration)||duration<=0||duration>180))throw new MirrorError('MEDIA_DIMENSIONS_UNSUPPORTED','Use one video/image stream, at most 40 megapixels and 180 seconds.');
  const filter=fit==='crop'?`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`:`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const encoding=type.kind==='image'?['-frames:v','1','-c:v','png']:['-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart','-t','180'];
  await runMediaProcess(process.env.AMCP_FFMPEG_PATH??'ffmpeg',['-v','error','-nostdin','-y','-threads','2',...guard,'-i',input,'-map','0:v:0',...(type.kind==='video'?['-map','0:a:0?']:[]),'-map_metadata','-1','-map_chapters','-1','-filter_threads','1','-vf',filter,...encoding,'-threads','2','-fs',String(MAX_MEDIA_BYTES+1),output]);
  const stat=await fs.stat(output);if(stat.size>MAX_MEDIA_BYTES||!stat.size)throw new MirrorError('MEDIA_TOO_LARGE','Converted media exceeds the configured media limit (128 MiB by default). Use a shorter or smaller source.');const converted=await fs.readFile(output);
  const check=JSON.parse(await runMediaProcess(process.env.AMCP_FFPROBE_PATH??'ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',output],15000)),outVideo=check.streams?.find((s:any)=>s.codec_type==='video');
  if(outVideo?.width!==width||outVideo?.height!==height||type.kind==='video'&&(!Number.isFinite(Number(check.format?.duration))||Math.abs(Number(check.format?.duration)-duration)>0.5))throw new MirrorError('MEDIA_CONVERSION_INCOMPLETE','Converted output is incomplete or has unexpected dimensions.');
  return {bytes:converted,...mediaType(converted),width,height,preset,fit,source_width:video.width,source_height:video.height,duration:type.kind==='video'?duration:null,review_note:fit==='crop'?'Center crop may remove important content. Inspect the preview before upload.':'Contains the full frame with black padding. Check placement requirements before upload.'};
 }finally{active--;if(directory){const root=path.resolve(os.tmpdir());if(path.dirname(path.resolve(directory))!==root||!path.basename(directory).startsWith('amcp-variant-'))throw Error('Invalid media temporary directory');await fs.rm(directory,{recursive:true,force:true});}}
}
