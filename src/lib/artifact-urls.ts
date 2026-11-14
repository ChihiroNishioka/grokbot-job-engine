import { z } from 'zod';

export const ARTIFACT_URL_MAX_CHARS = 1200;
export const artifactUrls = z.array(z.string()
  .refine(value => !/[\s\p{Cc}]/u.test(value) && [...value].length <= ARTIFACT_URL_MAX_CHARS)
  .pipe(z.url({ protocol: /^https$/ })))
  .max(20);

export function artifactOmissionFlags(urls: string[] = [], body = ''): { artifact_urls_omitted?: number } {
  const lines = new Set(body.split('\n'));
  const omitted = urls.filter(url => !lines.has(url)).length;
  return omitted > 0 ? { artifact_urls_omitted: omitted } : {};
}
