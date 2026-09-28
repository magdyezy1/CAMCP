import {MirrorError} from './errors.js';
import type {Connection} from './types.js';

/** Reviewed DV360 writes need the display-video OAuth scope; reads and verification use the grant as it is. */
export function assertDV360WriteScope(c:Connection,write=false):void{
 if(write&&!c.scopes.includes('https://www.googleapis.com/auth/display-video'))throw new MirrorError('PROVIDER_WRITE_SCOPE_REQUIRED','Reconnect DV360 with the display-video OAuth scope.');
}
