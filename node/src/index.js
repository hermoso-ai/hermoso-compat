// @hermoso/compat: drop-in compatibility layers for other social-posting SDKs, served by Hermoso's API.
// Import the one you are migrating from:
//   import SocialMediaAPI from '@hermoso/compat/ayrshare';   // Ayrshare's social-media-api
//   import Zernio from '@hermoso/compat/zernio';             // Zernio's @zernio/node
//   import Postiz from '@hermoso/compat/postiz';             // Postiz's @postiz/node
// Unofficial: written by Hermoso; not affiliated with Ayrshare, Zernio or Postiz.
export { HermosoClient, HermosoApiError, HermosoUnsupportedError, VERSION } from './core.js';
export { SocialMediaAPI } from './ayrshare.js';
export { Zernio } from './zernio.js';
export { Postiz } from './postiz.js';
