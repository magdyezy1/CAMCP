import {MirrorError} from './errors.js';
import type {CompiledRequest,Connection,JsonObject} from './types.js';
import type {TransportResult} from './transport.js';

/**
 * LinkedIn Message Ads and Conversation Ads content, per "Message Ads API" and "Conversation Ads API" of the Marketing API
 * (li-lms-2025-10 to li-lms-2026-09, pages updated 2026-06-24, checked 2026-09-27).
 * - InMail content (/rest/inMailContents) holds the sender, subject, body, footer and one sub-content: regular (a
 *   call-to-action text of at most 20 characters and a landing page of at most 1,024), guidedReplies (a sponsored
 *   conversation) or form (a call-to-action text for a lead form). Updates change name, sender, subject, htmlBody and
 *   subContent; "Once a creative goes live, you can't modify it further."
 * - A sponsored conversation (/rest/conversationAds) belongs to an ad account; its first message is set by a later partial
 *   update. Its messages (sponsoredMessageContents) form a tree of at most 25 messages without cycles; a body is a text (at
 *   most 500 characters), a lead form or an image with text; options (1–5) carry 1–35 characters of text and a reply type
 *   with its own rules.
 * Content serves only through a creative that references it; LinkedIn reviews creatives when they are activated.
 */
type Kind='inmail_create'|'inmail_update'|'conversation_create'|'conversation_update'|'message_create'|'message_update'|'message_delete';
type State={conversation?:string;inmail?:string;forms?:string[];absent?:string[]};
type Read=CompiledRequest&{linkedinMessageState?:State;linkedinMessagePage?:true;linkedinMessageConversation?:string};
const origin='https://api.linkedin.com',replyTypes=['LEAD_GENERATION','SIMPLE_REPLY','EXTERNAL_WEBSITE','LEAD_GENERATION_THANK_YOU'];
const maxMessages=25,maxOptions=5;
const object=(v:unknown):v is JsonObject=>!!v&&typeof v==='object'&&!Array.isArray(v);
const numeric=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):typeof v==='string'&&/^[1-9][0-9]{0,19}$/.test(v)?v:undefined;
function fail(code:string,message:string,details:JsonObject={},status=400):never{throw new MirrorError(code,message,details,status);}
function invalid(message:string):never{return fail('INVALID_LINKEDIN_MESSAGE_AD',message);}
function unverified(message:string):never{return fail('INCOMPLETE_STATE',message,{},502);}
function mismatch(message:string,details:JsonObject={}):never{return fail('STATE_TARGET_MISMATCH',message,details,409);}
const account=(p:CompiledRequest)=>{if(!/^[1-9][0-9]{0,19}$/.test(p.accountId??''))invalid('Select one sponsored account.');return p.accountId!;};
const accountUrn=(p:CompiledRequest)=>'urn:li:sponsoredAccount:'+account(p);
/** REST.li 2.0 scalar encoding: every reserved character of a key, including parentheses and commas. */
export const restliKey=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const conversationUrn=/^urn:li:sponsoredConversation:([1-9][0-9]{0,19})$/;
const messageUrn=/^urn:li:sponsoredMessageContent:\(urn:li:sponsoredConversation:([1-9][0-9]{0,19}),([1-9][0-9]{0,19})\)$/;
const inmailUrn=/^urn:li:adInMailContent:([1-9][0-9]{0,19})$/,imageUrn=/^urn:li:image:[A-Za-z0-9_-]{1,100}$/,formUrn=/^urn:li:adForm:([1-9][0-9]{0,19})$/;
const senderUrn=/^urn:li:(?:person:[A-Za-z0-9_-]{1,100}|organization:[1-9][0-9]{0,19})$/;
function segments(p:CompiledRequest):string[]|undefined{try{return p.path.split('/').slice(1).map(s=>decodeURIComponent(s));}catch{return undefined;}}
export function linkedinMessageKind(p:CompiledRequest):Kind|undefined{
 if(p.gateway!=='linkedin_native_action'||p.specialTransport||p.origin!==undefined&&p.origin!==origin)return;
 const s=segments(p);if(!s||s[0]!=='rest')return;
 if(s[1]==='inMailContents'){if(p.method==='POST'&&s.length===2)return 'inmail_create';if(p.method==='POST'&&s.length===3)return 'inmail_update';return;}
 if(s[1]!=='conversationAds')return;
 if(s.length===2)return p.method==='POST'?'conversation_create':undefined;
 if(s.length===3)return p.method==='POST'?'conversation_update':undefined;
 if(s[3]!=='sponsoredMessageContents')return;
 if(s.length===4)return p.method==='POST'?'message_create':p.method==='DELETE'?'message_delete':undefined;
 if(s.length===5&&p.method==='POST')return 'message_update';
 return;
}
/** The canonical REST.li path: URN keys fully encoded, so a message key's parentheses and comma reach LinkedIn intact. */
export function linkedinMessagePlan(p:CompiledRequest):CompiledRequest{
 if(p.gateway!=='linkedin_native_action'||!/^\/rest\/(?:conversationAds|inMailContents)(?:\/|$)/.test(p.path))return p;
 const s=segments(p);if(!s)return p;
 return {...p,path:'/'+s.map(x=>/^urn:li:/.test(x)?restliKey(x):x).join('/')};
}
/** The conversation of a path: its numeric ID or URN. */
function conversationOf(p:CompiledRequest):string{
 const raw=segments(p)![2]!,m=conversationUrn.exec(raw);
 if(m)return raw;if(/^[1-9][0-9]{0,19}$/.test(raw))return 'urn:li:sponsoredConversation:'+raw;
 return invalid('The conversation is urn:li:sponsoredConversation:{id} or its numeric ID.');
}
const text=(v:unknown,max:number,label:string,min=1)=>{if(typeof v!=='string'||[...v].length<min||[...v].length>max||/[\u0000]/.test(v))invalid(label+' has '+min+'–'+max+' characters.');return v as string;};
function url(v:unknown,label:string,max=1024):string{
 if(typeof v!=='string'||v.length>max||/[\s\u0000-\u001f\u007f]/.test(v))invalid(label+' is a URL of at most '+max+' characters without spaces.');
 let u:URL;try{u=new URL(v as string);}catch{return invalid(label+' must be an absolute URL.');}
 if(!['https:','http:'].includes(u.protocol)||u.username||u.password)invalid(label+' must be an http or https URL without credentials.');
 return v as string;
}
function keys(v:JsonObject,allowed:string[],label:string){const extra=Object.keys(v).filter(k=>!allowed.includes(k));if(extra.length)invalid(label+': unqualified fields '+extra.join(', ')+'.');}
function headers(p:CompiledRequest,methods:string[]){
 if(Object.keys(p.headers).some(k=>!['LinkedIn-Version','X-Restli-Protocol-Version','X-RestLi-Method'].includes(k))||p.headers['X-Restli-Protocol-Version']!=='2.0.0'||!/^20\d{4}$/.test(p.headers['LinkedIn-Version']??''))invalid('Use the native versioned REST.li 2.0 contract without other headers.');
 const m=p.headers['X-RestLi-Method']?.toUpperCase();if(m!==undefined&&!methods.includes(m))invalid('X-RestLi-Method must be '+methods.join(' or ')+' here.');
 return m;
}
function subContent(v:unknown,label:string){
 if(!object(v)||Object.keys(v).length!==1||!['regular','guidedReplies','form'].includes(Object.keys(v)[0]!))invalid(label+' is exactly one of regular, guidedReplies or form.');
 const [kind,c]=Object.entries(v)[0]!;if(!object(c))invalid(label+'.'+kind+' is an object.');
 if(kind==='regular'){keys(c,['callToActionText','callToActionLandingPageUrl','rightRailAdPicture'],label+'.regular');text(c.callToActionText,20,label+'.regular.callToActionText');url(c.callToActionLandingPageUrl,label+'.regular.callToActionLandingPageUrl');}
 else if(kind==='form'){keys(c,['callToActionText','rightRailAdPicture'],label+'.form');text(c.callToActionText,20,label+'.form.callToActionText');}
 else{keys(c,['sponsoredConversation','rightRailAdPicture'],label+'.guidedReplies');if(typeof c.sponsoredConversation!=='string'||!conversationUrn.test(c.sponsoredConversation))invalid(label+'.guidedReplies.sponsoredConversation is a sponsored conversation URN.');}
 if(c.rightRailAdPicture!==undefined&&(typeof c.rightRailAdPicture!=='string'||!imageUrn.test(c.rightRailAdPicture)))invalid(label+'.'+kind+'.rightRailAdPicture is an image URN.');
}
function body(v:unknown,label:string){
 if(!object(v)||Object.keys(v).length!==1||!['text','leadGenerationForm','mediaAttachment'].includes(Object.keys(v)[0]!))invalid(label+' is exactly one of text, leadGenerationForm or mediaAttachment.');
 if(v.text!==undefined)text(v.text,500,label+'.text');
 if(v.leadGenerationForm!==undefined&&(typeof v.leadGenerationForm!=='string'||!formUrn.test(v.leadGenerationForm)))invalid(label+'.leadGenerationForm is a lead form URN (urn:li:adForm:{id}).');
 if(v.mediaAttachment!==undefined){const m=v.mediaAttachment;if(!object(m))invalid(label+'.mediaAttachment is an object.');keys(m,['attachment','text'],label+'.mediaAttachment');if(typeof m.attachment!=='string'||!imageUrn.test(m.attachment))invalid(label+'.mediaAttachment.attachment is an image URN.');if(m.text!==undefined)text(m.text,500,label+'.mediaAttachment.text');}
}
function options(v:unknown,label:string,conversation:string){
 if(!object(v)||Object.keys(v).some(k=>k!=='options')||!Array.isArray(v.options)||!v.options.length||v.options.length>maxOptions)invalid(label+' is {options} with 1–'+maxOptions+' options.');
 (v.options as unknown[]).forEach((o,i)=>{
  const at=label+'.options['+i+']';if(!object(o))invalid(at+' is an object.');keys(o,['replyType','optionText','nextContent','landingPage'],at);
  if(!replyTypes.includes(o.replyType))invalid(at+'.replyType is one of '+replyTypes.join(', ')+'.');
  text(o.optionText,35,at+'.optionText');
  if(o.nextContent!==undefined){const m=typeof o.nextContent==='string'?messageUrn.exec(o.nextContent):null;if(!m||'urn:li:sponsoredConversation:'+m[1]!==conversation)invalid(at+'.nextContent is a message of the same conversation.');}
  if(o.landingPage!==undefined)url(o.landingPage,at+'.landingPage');
  if(o.replyType==='EXTERNAL_WEBSITE'&&o.landingPage===undefined)invalid(at+': an EXTERNAL_WEBSITE option needs landingPage.');
  if(o.replyType==='SIMPLE_REPLY'&&(o.landingPage!==undefined||o.nextContent===undefined))invalid(at+': a SIMPLE_REPLY option has nextContent and no landingPage.');
  if(o.replyType==='LEAD_GENERATION'&&o.nextContent===undefined)invalid(at+': a LEAD_GENERATION option needs nextContent, a lead form message.');
 });
}
function message(v:unknown,label:string,conversation:string,partial=false){
 if(!object(v))invalid(label+' is an object.');keys(v,['bodySource','nextAction'],label);
 if(!partial&&v.bodySource===undefined)invalid(label+'.bodySource is required.');
 if(v.bodySource!==undefined)body(v.bodySource,label+'.bodySource');
 if(v.nextAction!==undefined)options(v.nextAction,label+'.nextAction',conversation);
 if(partial&&!Object.keys(v).length)invalid(label+' sets bodySource, nextAction or both.');
}
function patch(p:CompiledRequest):JsonObject{
 const b=p.body;if(!object(b)||Object.keys(b).length!==1||!object(b.patch)||Object.keys(b.patch).length!==1||!object(b.patch.$set))invalid('A partial update is {patch: {$set: {...}}}.');
 return (b as JsonObject).patch.$set;
}
export function assertLinkedInMessage(p:CompiledRequest):void{
 const kind=linkedinMessageKind(p);if(!kind)return;
 account(p);
 const b=p.body,s=segments(p)!;
 if(kind!=='message_delete'&&Object.keys(p.query).length)invalid('Content writes take no query parameters.');
 switch(kind){
  case 'inmail_create':{
   headers(p,['CREATE']);if(!object(b))invalid('Provide the InMail content.');
   keys(b,['account','name','subject','sender','htmlBody','customFooter','subContent'],'InMail content');
   if(b.account!==accountUrn(p))fail('ACCOUNT_SCOPE_MISMATCH','account must be the selected ad account.',{},403);
   text(b.name,255,'name');text(b.subject,255,'subject');
   if(typeof b.sender!=='string'||!senderUrn.test(b.sender))invalid('sender is a person or organization URN allowed to send Message Ads.');
   if(b.htmlBody!==undefined)text(b.htmlBody,65536,'htmlBody');if(b.customFooter!==undefined)text(b.customFooter,65536,'customFooter');
   subContent(b.subContent,'subContent');return;
  }
  case 'inmail_update':{
   headers(p,['PARTIAL_UPDATE']);if(!inmailUrn.test(s[2]!))invalid('The path names an InMail content URN.');
   const set=patch(p);keys(set,['name','sender','subject','htmlBody','subContent'],'patch.$set');if(!Object.keys(set).length)invalid('Set at least one field.');
   if(set.name!==undefined)text(set.name,255,'name');if(set.subject!==undefined)text(set.subject,255,'subject');
   if(set.sender!==undefined&&(typeof set.sender!=='string'||!senderUrn.test(set.sender)))invalid('sender is a person or organization URN.');
   if(set.htmlBody!==undefined)text(set.htmlBody,65536,'htmlBody');if(set.subContent!==undefined)subContent(set.subContent,'subContent');return;
  }
  case 'conversation_create':{
   headers(p,['CREATE']);if(!object(b))invalid('Provide {parentAccount}.');keys(b,['parentAccount','headlineText'],'Conversation');
   if(b.parentAccount!==accountUrn(p))fail('ACCOUNT_SCOPE_MISMATCH','parentAccount must be the selected ad account.',{},403);
   if(b.headlineText!==undefined)text(b.headlineText,255,'headlineText');return;
  }
  case 'conversation_update':{
   headers(p,['PARTIAL_UPDATE']);const conversation=conversationOf(p),set=patch(p);keys(set,['firstMessageContent','headlineText'],'patch.$set');if(!Object.keys(set).length)invalid('Set firstMessageContent, headlineText or both.');
   if(set.firstMessageContent!==undefined){const m=typeof set.firstMessageContent==='string'?messageUrn.exec(set.firstMessageContent):null;if(!m||'urn:li:sponsoredConversation:'+m[1]!==conversation)invalid('firstMessageContent is a message of this conversation.');}
   if(set.headlineText!==undefined)text(set.headlineText,255,'headlineText');return;
  }
  case 'message_create':{
   const m=headers(p,['CREATE','BATCH_CREATE']),conversation=conversationOf(p);
   if(m==='BATCH_CREATE'){if(!object(b)||Object.keys(b).some(k=>k!=='elements')||!Array.isArray(b.elements)||!b.elements.length||b.elements.length>maxMessages)invalid('A batch creation is {elements} with 1–'+maxMessages+' messages.');(b.elements as unknown[]).forEach((e,i)=>message(e,'elements['+i+']',conversation));}
   else message(b,'Message',conversation);return;
  }
  case 'message_update':{
   headers(p,['PARTIAL_UPDATE']);const conversation=conversationOf(p),target=messageUrn.exec(s[4]!);
   if(!target||'urn:li:sponsoredConversation:'+target[1]!==conversation)invalid('The path names a message of this conversation.');
   message(patch(p),'patch.$set',conversation,true);return;
  }
  case 'message_delete':{
   headers(p,['BATCH_DELETE']);const conversation=conversationOf(p);
   if(p.body!==undefined&&p.body!==null&&(!object(p.body)||Object.keys(p.body).length))invalid('Deleting messages takes no body.');
   const ids=deletedIds(p);if(!ids.length||ids.length>maxMessages||new Set(ids).size!==ids.length)invalid('ids lists 1–'+maxMessages+' distinct messages.');
   for(const id of ids){const m=messageUrn.exec(id);if(!m||'urn:li:sponsoredConversation:'+m[1]!==conversation)invalid('Each id is a message of this conversation.');}
   if(Object.keys(p.query).some(k=>k!=='ids'))invalid('The only query parameter is ids.');return;
  }
 }
}
/** The message URNs of a batch deletion: ids=List(...) or repeated ids. */
function deletedIds(p:CompiledRequest):string[]{
 const raw=p.query.ids;const values=Array.isArray(raw)?raw.map(String):typeof raw==='string'?[raw]:[];
 const out:string[]=[];
 for(const v of values){let d=v;try{d=decodeURIComponent(v);}catch{invalid('ids are encoded message URNs.');}
  const list=/^List\((.*)\)$/.exec(d);if(!list){out.push(d);continue;}
  // A list of message URNs: split on the commas between URNs, not inside their parentheses.
  let depth=0,start=0;const inner=list[1]!;for(let i=0;i<=inner.length;i++){const c=inner[i];if(c==='(')depth++;else if(c===')')depth--;else if((c===','&&depth===0)||i===inner.length){const part=inner.slice(start,i).trim();if(part){let x=part;try{x=decodeURIComponent(part);}catch{invalid('ids are encoded message URNs.');}out.push(x);}start=i+1;}}
 }
 return out;
}
export function assertLinkedInMessageScope(c:Connection,write=false):void{
 if(!c.scopes.some(s=>write?s==='rw_ads':['r_ads','rw_ads'].includes(s)))fail('INSUFFICIENT_SCOPE',write?'Message and conversation ad writes require rw_ads.':'Message and conversation ad reads require r_ads or rw_ads.',{},403);
}
function read(p:CompiledRequest,path:string,query:JsonObject={}):Read{return {...p,action:'AMCP_LINKEDIN_MESSAGE_READ',method:'GET',path,query,body:undefined,headers:{'LinkedIn-Version':p.headers['LinkedIn-Version']!,'X-Restli-Protocol-Version':'2.0.0'},readOnly:true,destructive:false,requiresConfirmation:false,responseControls:undefined,linkedinMessageState:undefined,linkedinMessagePage:true,linkedinMessageConversation:undefined};}
const stateRead=(p:CompiledRequest,state:State):Read=>({...read(p,'/rest/adAccounts/'+account(p)),linkedinMessageState:state});
function formsOf(p:CompiledRequest):string[]{
 const kind=linkedinMessageKind(p)!,b=p.body as JsonObject,found=new Set<string>();
 const visit=(m:unknown)=>{if(object(m)&&object(m.bodySource)&&typeof m.bodySource.leadGenerationForm==='string')found.add(formUrn.exec(m.bodySource.leadGenerationForm)?.[1]??'');};
 if(kind==='message_create'){if(Array.isArray(b?.elements))b.elements.forEach(visit);else visit(b);}
 if(kind==='message_update')visit(patch(p));
 return [...found].filter(Boolean).sort();
}
export function linkedinMessageSnapshots(p:CompiledRequest):Read[]{
 const kind=linkedinMessageKind(p)!,s=segments(p)!,b=p.body as JsonObject;
 const state:State={forms:formsOf(p)};
 if(kind.startsWith('conversation_update')||kind.startsWith('message_'))state.conversation=conversationOf(p);
 if(kind==='inmail_update')state.inmail=s[2]!;
 const guided=kind==='inmail_create'?b?.subContent?.guidedReplies?.sponsoredConversation:kind==='inmail_update'?patch(p).subContent?.guidedReplies?.sponsoredConversation:undefined;
 if(typeof guided==='string')state.conversation=guided;
 return [stateRead(p,state)];
}
export function isLinkedInMessageRead(p:CompiledRequest):p is Read{return !!(p as Read).linkedinMessageState;}
/** Writes after validation; server-built reads of the account, a conversation, its messages once the conversation was read in the account, InMail content and lead forms. */
export function authorizeLinkedInMessage(p:CompiledRequest,c:Connection,id:string):boolean{
 if(linkedinMessageKind(p)){assertLinkedInMessage(p);assertLinkedInMessageScope(c,true);return true;}
 const internal=p as Read;if(p.gateway!=='linkedin_native_action'||!internal.linkedinMessagePage||p.action!=='AMCP_LINKEDIN_MESSAGE_READ'||p.method!=='GET'||!p.readOnly||p.body!==undefined)return false;
 assertLinkedInMessageScope(c);
 const q=Object.keys(p.query);
 if(!q.length&&(p.path==='/rest/adAccounts/'+id||/^\/rest\/conversationAds\/urn%3Ali%3AsponsoredConversation%3A[1-9][0-9]*$/.test(p.path)||/^\/rest\/inMailContents\/urn%3Ali%3AadInMailContent%3A[1-9][0-9]*$/.test(p.path)||/^\/rest\/leadForms\/[1-9][0-9]*$/.test(p.path)))return true;
 // Messages are listed only for a conversation the reader has just read in this ad account.
 if(internal.linkedinMessageConversation&&p.path==='/rest/conversationAds/'+restliKey(internal.linkedinMessageConversation)+'/sponsoredMessageContents'&&q.every(k=>['start','count'].includes(k)))return true;
 return fail('RESOURCE_SCOPE_REQUIRED','Unqualified internal message ad read.',{},403);
}
// LinkedIn replaces the text of a LEAD_GENERATION_THANK_YOU option with the form's thank-you message, so that text is not compared.
const optionView=(o:JsonObject)=>({replyType:o.replyType??null,optionText:o.replyType==='LEAD_GENERATION_THANK_YOU'?null:o.optionText??null,nextContent:o.nextContent??null,landingPage:o.landingPage??null});
const messageView=(m:JsonObject)=>({id:String(m.id),bodySource:object(m.bodySource)?m.bodySource:null,options:object(m.nextAction)&&Array.isArray(m.nextAction.options)?m.nextAction.options.map((o:JsonObject)=>optionView(o)):[]});
/** Message keys survive verification's case folding: "m" and the message number. */
const messageKey=(urn:string)=>'m'+(messageUrn.exec(urn)?.[2]??'');
export async function readLinkedInMessage(p:CompiledRequest,request:(p:CompiledRequest)=>Promise<TransportResult>):Promise<TransportResult>{
 const s=(p as Read).linkedinMessageState;if(!s)return request(p);
 let requests=0;
 const fetch=async(q:Read)=>{if(++requests>12)unverified('Message ad reads exceeded their bound.');const r=await request(q),d=r.data;if(r.status!==200||!object(d)||d.serviceErrorCode!==undefined||d.errors!==undefined&&!(object(d.errors)&&!Object.keys(d.errors).length))unverified('A required LinkedIn read failed or returned an error envelope.');return d as JsonObject;};
 const selected=await fetch(read(p,'/rest/adAccounts/'+account(p)));
 if(numeric(selected.id)!==account(p)||typeof selected.status!=='string')unverified('The selected ad account identity and status are required.');
 let conversation:JsonObject|null=null;const messages:JsonObject={};
 if(s.conversation){
  const d=await fetch(read(p,'/rest/conversationAds/'+restliKey(s.conversation)));
  if(d.id!==s.conversation||d.parentAccount!==accountUrn(p))mismatch('Conversation '+s.conversation+' is not a conversation of the selected ad account.',{conversation:s.conversation});
  conversation={id:s.conversation,firstMessageContent:d.firstMessageContent??null,headlineText:d.headlineText??null};
  const listed=await fetch({...read(p,'/rest/conversationAds/'+restliKey(s.conversation)+'/sponsoredMessageContents',{start:0,count:50}),linkedinMessageConversation:s.conversation});
  const elements=Array.isArray(listed.elements)?listed.elements:unverified('LinkedIn did not list the messages of the conversation.');
  if(elements.length>maxMessages||object(listed.paging)&&typeof listed.paging.total==='number'&&listed.paging.total>elements.length)unverified('The conversation has more messages than one page.');
  for(const m of elements){if(!object(m)||typeof m.id!=='string'||!messageUrn.test(m.id)||m.sponsoredConversation!==undefined&&m.sponsoredConversation!==s.conversation||messageUrn.exec(m.id)![1]!==conversationUrn.exec(s.conversation)![1])unverified('A message row is foreign or malformed.');messages[messageKey(m.id)]=messageView(m);}
 }
 let inmail:JsonObject|null=null;
 if(s.inmail){
  const d=await fetch(read(p,'/rest/inMailContents/'+restliKey(s.inmail)));
  if(d.id!==s.inmail||d.account!==accountUrn(p))mismatch('InMail content '+s.inmail+' is not content of the selected ad account.',{inmail_content:s.inmail});
  inmail={id:s.inmail,name:d.name??null,subject:d.subject??null,sender:d.sender??null,htmlBody:d.htmlBody??null,customFooter:d.customFooter??null,subContent:object(d.subContent)?d.subContent:null};
 }
 const forms:JsonObject={};
 for(const f of s.forms??[]){const d=await fetch(read(p,'/rest/leadForms/'+f));if(numeric(d.id)!==f)unverified('LinkedIn returned another lead form.');forms['f'+f]={id:f,account:d.account??null,state:d.state??null};}
 return {status:200,headers:{},data:{account:{id:account(p),status:selected.status},conversation,messages,inmail,forms}};
}
export function validateLinkedInMessageState(p:CompiledRequest,r:TransportResult):void{
 const s=(p as Read).linkedinMessageState,d=r.data;
 if(!s||r.status!==200||!object(d)||!object(d.account)||!object(d.messages)||!object(d.forms)||!!s.conversation!==object(d.conversation)||!!s.inmail!==object(d.inmail))unverified('Complete message ad state is missing.');
}
/** The messages after the request, keyed by message key, for the tree checks. New messages have no key yet. */
function afterMessages(p:CompiledRequest,s:JsonObject):{tree:Record<string,JsonObject>;added:JsonObject[]}{
 const kind=linkedinMessageKind(p)!,tree:Record<string,JsonObject>={};
 for(const [k,m] of Object.entries(s.messages as JsonObject))tree[k]=m as JsonObject;
 const added:JsonObject[]=[];
 const view=(m:JsonObject,id='new')=>({id,bodySource:m.bodySource??null,options:object(m.nextAction)?(m.nextAction.options as JsonObject[]).map(optionView):[]});
 if(kind==='message_create'){const b=p.body as JsonObject;for(const m of (Array.isArray(b.elements)?b.elements:[b]) as JsonObject[])added.push(view(m));}
 if(kind==='message_update'){const urn=segments(p)![4]!,k=messageKey(urn),set=patch(p),cur=tree[k];if(cur)tree[k]={...cur,...(set.bodySource!==undefined?{bodySource:set.bodySource}:{}),...(set.nextAction!==undefined?{options:(set.nextAction.options as JsonObject[]).map(optionView)}:{})};}
 if(kind==='message_delete')for(const id of deletedIds(p))delete tree[messageKey(id)];
 return {tree,added};
}
const isForm=(m:JsonObject|undefined)=>!!m&&object(m.bodySource)&&typeof m.bodySource.leadGenerationForm==='string';
export function linkedinMessagePrerequisites(p:CompiledRequest,states:unknown[]):void{
 const kind=linkedinMessageKind(p);if(!kind)return;
 const s=states[0];if(!object(s)||!object(s.messages)||!object(s.forms))unverified('Complete message ad state is missing.');
 for(const f of Object.values(s.forms)){if(object(f)&&f.account!==accountUrn(p))invalid('Lead form '+String(f.id)+' belongs to another ad account.');}
 if(kind==='inmail_create'||kind==='inmail_update'){
  const sub=kind==='inmail_create'?(p.body as JsonObject).subContent:patch(p).subContent;
  if(object(sub)&&object(sub.guidedReplies)){if(!object(s.conversation)||!s.conversation.firstMessageContent)invalid('Conversation '+String(sub.guidedReplies.sponsoredConversation)+' has no first message yet; set it before using the conversation.');}
  if(kind==='inmail_update'&&object(s.inmail)){const set=patch(p);if(Object.entries(set).every(([k,v])=>JSON.stringify(s.inmail![k])===JSON.stringify(v)))invalid('The InMail content already has these values.');}
  return;
 }
 if(kind==='conversation_create')return;
 const {tree,added}=afterMessages(p,s);
 const all=[...Object.values(tree),...added];
 if(all.length>maxMessages)invalid('A conversation has at most '+maxMessages+' messages; this request would leave '+all.length+'.');
 const byUrn=new Map<string,JsonObject>(Object.values(tree).map(m=>[String(m.id),m]));
 for(const m of all){
  const opts=(m.options??[]) as JsonObject[];
  if(isForm(m)&&!opts.some(o=>o.replyType==='LEAD_GENERATION_THANK_YOU'))invalid('A lead form message needs at least one LEAD_GENERATION_THANK_YOU option.');
  for(const o of opts){
   if(o.replyType==='LEAD_GENERATION_THANK_YOU'&&!isForm(m))invalid('LEAD_GENERATION_THANK_YOU options belong only to lead form messages.');
   if(o.nextContent==null)continue;const target=byUrn.get(String(o.nextContent));
   if(!target)invalid('Option "'+String(o.optionText)+'" points to message '+String(o.nextContent)+', which the conversation does not have after this request.');
   if(o.replyType==='LEAD_GENERATION'&&!isForm(target))invalid('A LEAD_GENERATION option must lead to a lead form message.');
   if(o.replyType!=='LEAD_GENERATION'&&isForm(target))invalid('Only LEAD_GENERATION options may lead to a lead form message.');
  }
 }
 // No cycles among the messages that exist after the request (new messages cannot be pointed at yet).
 const state=new Map<string,number>();
 const visit=(urn:string):void=>{const st=state.get(urn);if(st===1)invalid('The messages would form a cycle through '+urn+'.');if(st===2)return;state.set(urn,1);for(const o of (byUrn.get(urn)?.options??[]) as JsonObject[])if(o.nextContent)visit(String(o.nextContent));state.set(urn,2);};
 for(const urn of byUrn.keys())visit(urn);
 const first=kind==='conversation_update'?patch(p).firstMessageContent??(object(s.conversation)?s.conversation.firstMessageContent:null):object(s.conversation)?s.conversation.firstMessageContent:null;
 if(first&&!byUrn.has(String(first)))invalid(kind==='message_delete'?'The request deletes the first message of the conversation; point firstMessageContent elsewhere first.':'firstMessageContent must be a message of the conversation.');
 if(kind==='message_update'&&!byUrn.has(segments(p)![4]!))mismatch('Message '+segments(p)![4]+' is not a message of the conversation.');
 if(kind==='message_delete')for(const id of deletedIds(p))if(!object((s.messages as JsonObject)[messageKey(id)]))mismatch('Message '+id+' is not a message of the conversation.');
 if(kind==='conversation_update'&&object(s.conversation)){const set=patch(p);if(Object.entries(set).every(([k,v])=>s.conversation![k]===v))invalid('The conversation already has these values.');}
}
export function linkedinMessageImpact(p:CompiledRequest,state:unknown[]):JsonObject|undefined{
 const kind=linkedinMessageKind(p);if(!kind)return;
 const first=state[0],s:JsonObject=object(first)?first:{};
 const live=kind==='conversation_create'||kind==='inmail_create'||kind==='message_create'?false:true;
 return {provider:'linkedin',scope:kind.startsWith('inmail')?'inmail_content':'sponsored_conversation',operation:kind,conversation:object(s.conversation)?s.conversation:null,inmail:object(s.inmail)?s.inmail:null,may_affect_serving:live,
  effect:(kind.startsWith('inmail')?'InMail content':'Conversation content')+' serves only through a Message or Conversation Ad creative that references it; LinkedIn reviews a creative when it is activated.'+(live?' If an active creative already uses this content, members see the change; LinkedIn refuses changes to InMail content of live creatives.':''),
  verification:'Reads the content again and compares every field sent'+(kind==='message_delete'?', and that deleted messages are gone':'')+'.',
  source:'https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/'+(kind.startsWith('inmail')?'message-ads-integrations':'conversation-ads-integrations')};
}
export function linkedinMessageOutcome(p:CompiledRequest,r:TransportResult):boolean{
 const kind=linkedinMessageKind(p)!,d=r.data,m=p.headers['X-RestLi-Method']?.toUpperCase();
 const empty=d===null||d===undefined||object(d)&&!Object.keys(d).length;
 if(kind==='inmail_update'||kind==='conversation_update'||kind==='message_update')return (r.status===204||r.status===200)&&empty;
 if(kind==='message_delete'){if(r.status!==200||!object(d)||!object(d.results)||object(d.errors)&&Object.keys(d.errors).length)return false;const ids=deletedIds(p);return ids.every(id=>object(d.results[id])&&d.results[id].status===204)&&Object.keys(d.results).length===ids.length;}
 if(kind==='message_create'&&m==='BATCH_CREATE'){const n=(p.body as JsonObject).elements.length;return [200,201].includes(r.status)&&object(d)&&Array.isArray(d.elements)&&d.elements.length===n&&d.elements.every((e:unknown)=>object(e)&&e.status===201&&typeof e.id==='string'&&messageUrn.test(e.id));}
 const id=String(r.headers['x-restli-id']??'');
 if(r.status!==201||!(empty||object(d)&&d.serviceErrorCode===undefined))return false;
 return kind==='inmail_create'?inmailUrn.test(id)||/^[1-9][0-9]*$/.test(id):kind==='conversation_create'?conversationUrn.test(id)||/^[1-9][0-9]*$/.test(id):messageUrn.test(id);
}
const created=(kind:Kind,id:string)=>kind==='inmail_create'&&/^[1-9]/.test(id)?'urn:li:adInMailContent:'+id:kind==='conversation_create'&&/^[1-9]/.test(id)?'urn:li:sponsoredConversation:'+id:id;
export function linkedinMessageVerification(p:CompiledRequest,result:JsonObject,_before:unknown[]):{read:CompiledRequest;expected:JsonObject;id:string}[]{
 const kind=linkedinMessageKind(p)!,b=p.body as JsonObject,headersOf=result.headers??{};
 if(kind==='inmail_create'||kind==='inmail_update'){
  const urn=kind==='inmail_create'?created(kind,String(headersOf['x-restli-id']??'')):segments(p)![2]!;if(!inmailUrn.test(urn))fail('VERIFICATION_UNSUPPORTED','The receipt names no InMail content to verify.');
  const fields=kind==='inmail_create'?Object.fromEntries(Object.entries(b).filter(([k])=>k!=='account')):patch(p);
  return [{read:stateRead(p,{inmail:urn,forms:[]}),expected:{inmail:{id:urn,...fields}},id:urn}];
 }
 if(kind==='conversation_create'){
  const urn=created(kind,String(headersOf['x-restli-id']??''));if(!conversationUrn.test(urn))fail('VERIFICATION_UNSUPPORTED','The receipt names no conversation to verify.');
  return [{read:stateRead(p,{conversation:urn,forms:[]}),expected:{conversation:{id:urn,...(b.headlineText!==undefined?{headlineText:b.headlineText}:{})}},id:urn}];
 }
 const conversation=conversationOf(p),expected:JsonObject={};
 if(kind==='conversation_update')return [{read:stateRead(p,{conversation,forms:[]}),expected:{conversation:{id:conversation,...patch(p)}},id:conversation}];
 const view=(m:JsonObject)=>({...(m.bodySource!==undefined?{bodySource:m.bodySource}:{}),...(m.nextAction!==undefined?{options:(m.nextAction.options as JsonObject[]).map(optionView)}:{})});
 if(kind==='message_create'){
  const m=p.headers['X-RestLi-Method']?.toUpperCase(),ids=m==='BATCH_CREATE'?(result.data?.elements??[]).map((e:JsonObject)=>String(e.id)):[String(headersOf['x-restli-id']??'')];
  const sent=m==='BATCH_CREATE'?b.elements as JsonObject[]:[b];
  ids.forEach((id:string,i:number)=>{if(!messageUrn.test(id))fail('VERIFICATION_UNSUPPORTED','The receipt names no message to verify.');expected[messageKey(id)]={present:true,...view(sent[i]!)};});
 }
 if(kind==='message_update')expected[messageKey(segments(p)![4]!)]={present:true,...view(patch(p))};
 if(kind==='message_delete')for(const id of deletedIds(p))expected[messageKey(id)]={present:false};
 return [{read:stateRead(p,{conversation,forms:[],absent:kind==='message_delete'?deletedIds(p).map(messageKey):[]}),expected:{messages:expected},id:conversation}];
}
export function linkedinMessageObserved(read:CompiledRequest,data:JsonObject):JsonObject{
 const messages:JsonObject={};
 for(const [k,m] of Object.entries(object(data.messages)?data.messages:{}))if(object(m))messages[k]={present:true,bodySource:m.bodySource,options:m.options};
 for(const k of (read as Read).linkedinMessageState?.absent??[])if(!Object.hasOwn(messages,k))messages[k]={present:false};
 return {conversation:data.conversation??null,inmail:data.inmail??null,messages};
}
