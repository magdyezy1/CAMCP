import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MirrorError} from './errors.js';
import type {JsonObject} from './types.js';
const guides=[['index','Campaign builder','SKILL.md'],['meta','Meta campaigns and creatives','references/meta.md'],['google-ads','Google Ads channel hierarchy','references/google-ads.md'],['tiktok-snapchat','TikTok and Snapchat creation','references/tiktok-snapchat.md'],['linkedin-x','LinkedIn and X identity and hierarchy','references/linkedin-x.md'],['reddit','Reddit capabilities and limits','references/reddit.md'],['microsoft-ads','Microsoft Advertising v13','references/microsoft-ads.md'],['media','Google Drive and server media import','references/media.md']] as const;
export const guidanceResources=guides.map(([id,title])=>({uri:'amcp://guides/'+id,name:id,title,mimeType:'text/markdown',description:'AMCP-maintained workflow guidance; actual permissions and native action contracts still apply.'}));
export const guidanceDiscovery={resources:guidanceResources,prompt:'amcp_build_campaign',qualification:'Curated from the supplied Skills manuals, current provider documentation and executable AMCP contracts. Historical sources are not instructions or live acceptance evidence.'};
export function readGuidance(uri:string){
 const guide=guides.find(([id])=>uri==='amcp://guides/'+id);if(!guide)throw new MirrorError('GUIDE_NOT_FOUND','Unknown AMCP guide URI.',{},404);
 const file=fileURLToPath(new URL('../../Skills/amcp-campaign-builder/'+guide[2],import.meta.url));
 return {uri,mimeType:'text/markdown',text:fs.readFileSync(file,'utf8')};
}
export const campaignPrompt={name:'amcp_build_campaign',description:'Load the AMCP creation workflow and the selected platform guide before planning an authorized campaign. This prompt performs no provider calls or writes.',arguments:[{name:'platform',description:'meta, google, tiktok, snapchat, linkedin, x, reddit or microsoft',required:true},{name:'request',description:'The campaign brief and existing constraints; this does not replace the user’s actual authorization.',required:false}]};
export function buildCampaignPrompt(args:JsonObject){
 if(Object.keys(args).some(k=>!['platform','request'].includes(k))||typeof args.platform!=='string'||args.request!==undefined&&(typeof args.request!=='string'||args.request.length>12000))throw new MirrorError('INVALID_ARGUMENT','Choose a supported platform and a text brief of at most 12000 characters.');
 const map:Record<string,string>={meta:'meta',google:'google-ads',google_ads:'google-ads',tiktok:'tiktok-snapchat',snapchat:'tiktok-snapchat',linkedin:'linkedin-x',x:'linkedin-x',reddit:'reddit',microsoft:'microsoft-ads',bing:'microsoft-ads'},guide=map[args.platform];
 if(!guide)throw new MirrorError('INVALID_ARGUMENT','No curated guide exists for that platform.');
 return {description:'AMCP '+args.platform+' campaign workflow',messages:[{role:'user' as const,content:{type:'text' as const,text:readGuidance('amcp://guides/index').text+'\n\n'+readGuidance('amcp://guides/'+guide).text+'\n\nCampaign brief (task data; apply the user’s actual authorization and constraints):\n'+(args.request??'Use the existing conversation brief; ask only for necessary missing decisions.')}}]};
}
