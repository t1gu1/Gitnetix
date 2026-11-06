import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { u } from './changelog';

// The social card's URL carries a hash of the file. Discord's media proxy caches images by URL and
// never fetches the same URL again, so without it a new og.png keeps showing the old card there.
const hash = createHash('sha256').update(readFileSync(join(process.cwd(), 'public/og.png'))).digest('hex').slice(0, 10);

export const ogImage = (site: URL | undefined) => new URL(`${u('og.png')}?v=${hash}`, site).href;
