export const MEDIA_COOKIE = 'ainvr-media';
export function mediaCookie(token: string, secure = false): string {
  return `${MEDIA_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${token ? 43200 : 0}`;
}
