import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const icon=await readFile(new URL('../public/favicon.svg',import.meta.url));
for(const size of [180,192,512])await sharp(icon).resize(size,size).png().toFile(fileURLToPath(new URL(`../public/icon-${size}.png`,import.meta.url)));
