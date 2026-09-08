import type {JsonObject} from './types.js';
import {MirrorError} from './errors.js';
const numeric=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
/** Separate existing Instagram media from Facebook post IDs; never invent an identity. */
export function validateMetaCreative(body:JsonObject){
 const story=body.object_story_spec&&typeof body.object_story_spec==='object'&&!Array.isArray(body.object_story_spec)?body.object_story_spec:{};
 const missing:string[]=[];
 if(body.source_instagram_media_id!==undefined){
  if(!numeric(body.source_instagram_media_id))missing.push('source_instagram_media_id');
  if(!numeric(body.instagram_user_id))missing.push('instagram_user_id');
  if(body.object_story_id||Object.keys(story).length)throw new MirrorError('CREATIVE_IDENTITY_CONFLICT','Choose existing Instagram media, a Facebook post, or a new Page story; do not combine these sources.');
 }else{
  if(!body.object_story_id&&!Object.keys(story).length)missing.push('object_story_spec.page_id or object_story_id');
  if(body.object_story_id!==undefined&&(typeof body.object_story_id!=='string'||! /^[1-9][0-9]*_[1-9][0-9]*$/.test(body.object_story_id)))missing.push('object_story_id (Facebook pageId_postId)');
  if(Object.keys(story).length&&!numeric(story.page_id))missing.push('object_story_spec.page_id');
  if(story.link_data&&!story.link_data.link)missing.push('object_story_spec.link_data.link');
 }
 if(missing.length)throw new MirrorError('CREATIVE_INPUT_REQUIRED','A Meta creative needs a verified identity: Page story, Facebook post, or existing Instagram media with its Instagram user. Link stories also need a destination URL.',{missing_fields:missing});
}
