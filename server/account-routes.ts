import express,{type Request,type Response,type NextFunction} from 'express';
import {WebStore} from './web-store.js';
import {UserAccounts} from './user-accounts.js';
import {SocialSignIn} from './social-signin.js';
import {MirrorError} from '../src/errors.js';
import {sha256} from '../src/security.js';
import type {JsonObject} from '../src/types.js';
import {AccountSecurity} from './account-security.js';

export function accountRoutes(web:WebStore,accounts:UserAccounts,social:SocialSignIn){
 const router=express.Router(),handle=(fn:(req:Request,res:Response)=>unknown)=>async(req:Request,res:Response,next:NextFunction)=>{try{await fn(req,res);}catch(e){next(e);}};
 const security=new AccountSecurity(accounts);
 const signed=(res:Response,s:ReturnType<WebStore['createSession']>)=>{res.setHeader('Set-Cookie',web.cookie(s.id));return {authenticated:true,csrf:s.csrf,...accounts.profile(s)};};
 router.use(['/api/account','/api/signin'],(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 router.get('/api/account/options',(_req,res)=>res.json({providers:social.publicConfig().filter(p=>p.configured||web.session(_req)?.actor.role==='admin'),emailEnabled:accounts.emailConfigured,signupEnabled:accounts.signupEnabled,administratorEnabled:web.configured,testEnabled:web.testConfigured}));
 const post=(route:string,fn:(req:Request,res:Response)=>unknown)=>router.post(route,express.json({limit:'8kb'}),handle((req,res)=>{web.requireOrigin(req);if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new MirrorError('INVALID_ARGUMENT','Enter valid account details.');return fn(req,res);}));
 post('/api/account/register',async(req,res)=>res.json(await accounts.register(req,req.body)));
 post('/api/account/login',async(req,res)=>{const old=web.session(req),s=await accounts.login(req,req.body);if(old)web.signOut(old.id);if('mfaRequired' in s){res.json(s);return;}res.json(signed(res,s));});
 post('/api/account/forgot-password',async(req,res)=>res.json(await accounts.requestReset(req,req.body)));
 post('/api/account/verify-email',async(req,res)=>res.json(await (req.body.kind==='owner'?security.finishOwner(req,req.body):req.body.kind==='invite'?security.accept(req,req.body):accounts.finishEmail(req,req.body))));
 post('/api/account/resend-verification',async(req,res)=>res.json(await accounts.register(req,req.body)));
 post('/api/account/owner-setup',async(req,res)=>res.json(await security.beginOwner(req,req.body)));
 post('/api/account/mfa/start',(req,res)=>res.json(security.beginMfa(req)));
 post('/api/account/mfa/enable',(req,res)=>{const r=security.enableMfa(req,req.body);res.json({...signed(res,r.session),recoveryCodes:r.recoveryCodes});});
 post('/api/account/mfa/login',(req,res)=>res.json(signed(res,security.finishMfa(req,req.body))));
 post('/api/account/mfa/disable',(req,res)=>res.json(signed(res,security.disableMfa(req,req.body))));
 router.get('/api/owner/accounts',handle((req,res)=>res.json({...security.accessRequests(req),setup:accounts.setupGaps(),providers:social.publicConfig().map(p=>({id:p.id,name:p.name,configured:p.configured}))})));
 post('/api/owner/accounts/access',(req,res)=>res.json(security.setAccess(req,req.body)));
 post('/api/owner/accounts/test-invite',async(req,res)=>res.json(await security.inviteTestAccount(req,req.body)));
 router.get('/api/workspaces',handle((req,res)=>res.json(security.workspaces(req))));
 post('/api/workspaces/switch',(req,res)=>res.json(signed(res,security.switchWorkspace(req,req.body))));
 router.get('/api/workspaces/members',handle((req,res)=>res.json(security.members(req))));
 post('/api/workspaces/invite',async(req,res)=>res.json(await security.invite(req,req.body)));
 post('/api/workspaces/member',(req,res)=>res.json(security.changeMember(req,req.body)));
 router.get('/api/account/delivery',handle((req,res)=>{web.requireSession(req).actor.role==='admin'||(()=>{throw new MirrorError('FORBIDDEN','Administrator access required.',{},403);})();res.json({configured:accounts.emailConfigured,sender:accounts.emailConfigured?accounts.env.AMCP_EMAIL_FROM:null,jobs:web.store.db.prepare('SELECT state,count(*) AS count,min(available_at) AS nextAttempt FROM amcp_email_outbox WHERE tenant_id=? GROUP BY state').all(web.requireSession(req).actor.tenantId)});}));
 post('/api/account/email',async(req,res)=>res.json(await accounts.requestEmail(req,req.body)));
 router.get('/api/account',handle((req,res)=>res.json(accounts.profile(web.requireSession(req)))));
 post('/api/account/profile',(req,res)=>res.json(accounts.update(req,req.body)));
 post('/api/account/password',async(req,res)=>{const s=await accounts.changePassword(req,req.body);res.setHeader('Set-Cookie',web.cookie(s.id));res.json({authenticated:true,csrf:s.csrf,...accounts.profile(s)});});
 const ownedSessions=(req:Request)=>{const s=web.requireSession(req),rows=web.store.db.prepare("SELECT hash,actor,expires_at FROM amcp_web_sessions WHERE json_extract(actor,'$.userId')=? AND json_extract(actor,'$.tenantId')=? AND expires_at>?").all(s.actor.userId,s.actor.tenantId,Date.now()) as JsonObject[];return {s,rows};};
 router.get('/api/account/sessions',handle((req,res)=>{const {s,rows}=ownedSessions(req);res.json({sessions:rows.map(r=>({id:sha256('public-session:'+r.hash),current:r.hash===sha256(s.id),expiresAt:r.expires_at,signedInAt:JSON.parse(r.actor).signedInAt??r.expires_at-8*3600000}))});}));
 router.delete('/api/account/sessions/:id',handle((req,res)=>{web.requireMutation(req);const {s,rows}=ownedSessions(req),row=rows.find(r=>sha256('public-session:'+r.hash)===req.params.id);if(!row)throw new MirrorError('NOT_FOUND','Session not found.',{},404);web.store.db.prepare('DELETE FROM amcp_web_sessions WHERE hash=?').run(row.hash);web.store.db.prepare('DELETE FROM amcp_oauth_states WHERE session_hash=?').run(row.hash);if(row.hash===sha256(s.id))res.setHeader('Set-Cookie',web.cookie('',0));res.json({success:true});}));
 router.delete('/api/account/identities/:provider',handle((req,res)=>{accounts.unlink(req,social.provider(String(req.params.provider)));res.json({success:true});}));
 post('/api/signin/:provider/start',(req,res)=>{const result=social.start(req,String(req.params.provider),req.body);res.setHeader('Set-Cookie',result.cookie);res.json({url:result.url});});
 const callback=handle(async(req,res)=>{
  try{const input=req.method==='POST'?req.body:req.query;if(!input||Object.values(input).some(v=>typeof v!=='string'||v.length>16384))throw new MirrorError('SIGNIN_IDENTITY_INVALID','Invalid sign-in callback.');
   const result=await social.finish(req,String(req.params.provider),input);if('mfaRequired' in result){res.setHeader('Set-Cookie',social.cookie('',0));res.redirect(303,'/login#mfa='+encodeURIComponent(result.ticket));return;}res.setHeader('Set-Cookie',[web.cookie(result.session.id),social.cookie('',0)]);res.redirect(303,result.linked?'/account?linked=true':'/auth/complete');
  }catch(e){const allowed=['ACCOUNT_EXISTS','SIGNIN_CANCELLED','SIGNIN_STATE_INVALID','IDENTITY_ALREADY_LINKED','SIGNUP_DISABLED','SIGNIN_SETUP_REQUIRED','ACCOUNT_PENDING_APPROVAL'];const code=e instanceof MirrorError&&allowed.includes(e.code)?e.code:'SIGNIN_FAILED';res.setHeader('Set-Cookie',social.cookie('',0));res.redirect(303,'/login?error='+code);}
 });
 router.get('/api/signin/:provider/callback',callback);router.post('/api/signin/:provider/callback',express.urlencoded({extended:false,limit:'24kb'}),callback);
 return router;
}
