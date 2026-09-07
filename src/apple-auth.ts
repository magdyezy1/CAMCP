import {createPrivateKey,sign} from 'node:crypto';
import {MirrorError} from './errors.js';
import type {Credentials,JsonObject} from './types.js';

/** Apple Ads client credentials use ES256, not Sign in with Apple's browser flow. */
export function appleClientSecret(c:Credentials,now=Math.floor(Date.now()/1000)):string{
 if(!c.applePrivateKey){if(c.clientSecret)return c.clientSecret;throw new MirrorError('REAUTHORIZATION_REQUIRED','Configure an Apple Ads signing key or current client secret.',{},401);}
 if(!c.clientId||!c.appleTeamId||!c.appleKeyId)throw new MirrorError('REAUTHORIZATION_REQUIRED','Apple Ads signing requires the client ID, team ID and key ID.',{},401);
 try{
  const key=createPrivateKey(c.applePrivateKey.replaceAll('\\n','\n'));
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error();
  const header=Buffer.from(JSON.stringify({alg:'ES256',kid:c.appleKeyId})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iss:c.appleTeamId,sub:c.clientId,aud:'https://appleid.apple.com',iat:now-30,exp:now+300})).toString('base64url');
  const input=header+'.'+payload,signature=sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  return input+'.'+signature;
 }catch{throw new MirrorError('APPLE_SIGNING_KEY_INVALID','Apple Ads requires a valid P-256 PEM private key.',{},400);}
}
export async function requestAppleAccessToken(c:Credentials,fetcher:typeof fetch=fetch):Promise<Credentials>{
 if(!c.clientId)throw new MirrorError('REAUTHORIZATION_REQUIRED','Configure the Apple Ads client ID.',{},401);
 const body=new URLSearchParams({grant_type:'client_credentials',client_id:c.clientId,client_secret:appleClientSecret(c),scope:'searchadsorg'});
 let response:Response;
 try{response=await fetcher('https://appleid.apple.com/auth/oauth2/token',{method:'POST',body,headers:{'Content-Type':'application/x-www-form-urlencoded'},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new MirrorError('TOKEN_REFRESH_FAILED','Apple Ads authentication could not be reached.',{},503,true);}
 const chunks:Uint8Array[]=[];let size=0;const reader=response.body?.getReader();
 if(reader)try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024*1024){await reader.cancel();throw new MirrorError('TOKEN_REFRESH_FAILED','Apple Ads returned an oversized token response.',{},502);}chunks.push(part.value);}}finally{reader.releaseLock();}
 let data:JsonObject;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();}catch{throw new MirrorError('TOKEN_REFRESH_FAILED','Apple Ads returned an invalid token response.',{},502);}
 if(!response.ok||data.error||typeof data.access_token!=='string'||!data.access_token||data.token_type!==undefined&&String(data.token_type).toLowerCase()!=='bearer')throw new MirrorError('TOKEN_REFRESH_FAILED','Apple Ads rejected the API credentials. Verify the uploaded public key and API role.',{http_status:response.status},401);
 const lifetime=Number(data.expires_in);if(!Number.isFinite(lifetime)||lifetime<=0)throw new MirrorError('TOKEN_REFRESH_FAILED','Apple Ads returned an invalid access-token lifetime.',{},502);
 return {...c,accessToken:data.access_token,expiresAt:Date.now()+lifetime*1000};
}
