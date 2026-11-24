import { HermosoClient, HermosoApiError, HermosoUnsupportedError, ToolResult } from './core';
export { HermosoApiError, HermosoUnsupportedError };
type Data = Record<string, any>;
type Res = Promise<Record<string, any>>;
export interface SocialMediaAPIOptions { baseUrl?: string; waitForPublish?: boolean; publishTimeoutMs?: number; rehostMedia?: boolean; fetch?: typeof fetch; }
/** Unofficial Ayrshare `social-media-api` compatible client, served by Hermoso. Not affiliated with Ayrshare. */
export declare class SocialMediaAPI {
  constructor(apiKey?: string, options?: SocialMediaAPIOptions);
  hermoso: HermosoClient;
  setProfileKey(profileKey: string | null): this;
  setTwitterByo(apiKey: string, apiSecret: string): this;
  clearTwitterByo(): this;
  callTool(name: string, args?: Data): Promise<ToolResult>;
  post(data: Data): Res; delete(data: Data): Res; updatePost(data: Data): Res; retryPost(data: Data): Res; getPost(data: Data): Res;
  history(params?: Data): Res; media(params?: Data): Res; verifyMediaExists(params: Data): Res; mediaUploadUrl(params?: Data): Res;
  mediaMeta(params?: Data): never; resizeImage(params?: Data): never; upload(data: Data): Res;
  analyticsLinks(params?: Data): never; analyticsPost(data: Data): Res; analyticsSocial(data?: Data): Res; user(params?: Data): Res; shorten(data?: Data): never;
  feedAdd(data?: Data): never; feedDelete(data?: Data): never; feedGet(params?: Data): never; feedUpdate(data?: Data): never;
  postComment(data: Data): Res; getComments(params: Data): Res; deleteComments(params: Data): Res; replyComment(params: Data): Res;
  createProfile(data: Data): Res; deleteProfile(data?: Data): never; updateProfile(data: Data): Res; getProfiles(params?: Data): Res;
  generateJWT(data: Data): Res; unlinkSocial(data: Data): Res;
  setAutoSchedule(data: Data): Res; deleteAutoSchedule(data: Data): Res; listAutoSchedule(params?: Data): Res;
  registerWebhook(data: Data): Res; unregisterWebhook(data: Data): Res; listWebhooks(params?: Data): Res; getBrandByUser(params?: Data): never;
  generatePost(params: Data): Res; generateRewrite(params: Data): Res; generateTranscription(params: Data): Res; generateTranslation(params: Data): Res;
  generateAltText(params?: Data): never; autoHashtags(params?: Data): never; recommendHashtags(params?: Data): never; checkBannedHashtags(params?: Data): never;
  shortLink(params?: Data): never; shortLinkAnalytics(params?: Data): never;
  reviews(params?: Data): Res; review(params: Data): Res; replyReview(params: Data): Res; deleteReplyReview(params: Data): Res;
}
export default SocialMediaAPI;
