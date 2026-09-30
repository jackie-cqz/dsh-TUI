/**
 * Live `@image` admission regression (#948): adapted bytes and media type reach
 * the store, the user gets adjustment metadata, source order/budgets survive,
 * and animations that need conversion are refused without a silent still.
 * Run: node --import tsx/esm scripts/verify-mention-image-admission.ts
 */
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import sharp from 'sharp'
import { expandComposerMentions } from '../src/dsh-adapter/channel/composer-mentions.js'
import type { MentionAttachments, MentionFs } from '../src/dsh-adapter/channel/types.js'

const large = await sharp({ create: {
  width: 1800, height: 900, channels: 3, background: '#336699',
} }).png().toBuffer()
const small = await sharp({ create: {
  width: 16, height: 16, channels: 3, background: '#224466',
} }).jpeg().toBuffer()
const frames = await Promise.all(['#ff0000', '#00ff00'].map(background =>
  sharp({ create: { width: 16, height: 16, channels: 3, background } }).png().toBuffer()))
const animated = await sharp(frames, { join: { animated: true } }).webp().toBuffer()
const files = new Map([['large.png', large], ['small.jpg', small], ['animated.webp', animated]])
const fs: MentionFs = {
  resolve: async path => ({ displayPath: basename(path) }),
  stat: async target => files.has(target.displayPath) ? { type: 'file' } : undefined,
  readText: async () => '',
  readBytes: async (target, _signal, maxBytes) => {
    const bytes = files.get(target.displayPath)
    assert.ok(bytes)
    assert.ok(bytes.byteLength <= maxBytes)
    return bytes
  },
  listDir: async () => [],
}

const saved: Array<{ data: Uint8Array; mediaType: string; name?: string }> = []
const attachments: MentionAttachments = {
  imageLimits: {
    maxImageBytes: 2_000_000,
    maxImagesPerMessage: 2,
    maxMessageImageBytes: 2_000_000,
    maxImageDimension: 1024,
    maxImagePixels: 1_000_000,
    mediaTypes: ['image/jpeg'],
  },
  saveImage: async input => {
    saved.push(input)
    const meta = await sharp(input.data).metadata()
    return {
      attachmentId: `sha256:mention-${saved.length}` as never,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      name: input.name,
    }
  },
}

const staged = {
  attachmentId: 'sha256:staged' as never,
  mediaType: 'image/jpeg' as const,
  bytes: 100,
  width: 10,
  height: 10,
}
const text = '@large.png [Image #1] @small.jpg'
const result = await expandComposerMentions(fs, '/ws', text, attachments, new Map([['[Image #1]', staged]]))
assert.equal(result.blocks[0]?.type, 'text')
assert.equal(result.blocks[1]?.type, 'image')
assert.equal(result.blocks[2]?.type, 'image')
if (result.blocks[2]?.type === 'image') assert.equal(result.blocks[2].attachment, staged)
assert.deepEqual(result.attached, ['large.png'])
assert.deepEqual(result.missing, ['small.jpg'])
assert.equal(saved.length, 1)
assert.equal(saved[0]?.mediaType, 'image/jpeg')
const admitted = await sharp(saved[0]!.data).metadata()
assert.ok((admitted.width ?? Infinity) <= 1024)
assert.ok((admitted.height ?? Infinity) <= 1024)
assert.deepEqual(result.adjustedImages.map(item => item.path), ['large.png'])
assert.equal(result.adjustedImages[0]?.adjustment.mediaType, 'image/jpeg')
assert.equal(result.adjustedImages[0]?.adjustment.resized, true)
assert.equal(result.adjustedImages[0]?.adjustment.width, admitted.width)

const byteLimited = await expandComposerMentions(fs, '/ws', '@large.png [Image #1]', {
  ...attachments,
  imageLimits: { ...attachments.imageLimits, maxMessageImageBytes: 100 },
}, new Map([['[Image #1]', staged]]))
assert.deepEqual(byteLimited.missing, ['large.png'])
assert.equal(byteLimited.blocks[1]?.type, 'image')
if (byteLimited.blocks[1]?.type === 'image') assert.equal(byteLimited.blocks[1].attachment, staged)

const unchanged = await expandComposerMentions(fs, '/ws', '@small.jpg', attachments)
assert.deepEqual(unchanged.missing, [])
assert.deepEqual(unchanged.adjustedImages, [])
assert.equal(saved.at(-1)?.data, small)

const storeNormalized = await expandComposerMentions(fs, '/ws', '@small.jpg', {
  ...attachments,
  saveImage: async input => ({
    attachmentId: 'sha256:normalized' as never,
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 8,
    height: 8,
  }),
})
assert.equal(storeNormalized.adjustedImages[0]?.adjustment.resized, true)
assert.equal(storeNormalized.adjustedImages[0]?.adjustment.width, 8)

const storeConverted = await expandComposerMentions(fs, '/ws', '@small.jpg', {
  ...attachments,
  imageLimits: { ...attachments.imageLimits, mediaTypes: ['image/jpeg', 'image/webp'] },
  saveImage: async input => ({
    attachmentId: 'sha256:converted' as never,
    mediaType: 'image/webp',
    bytes: input.data.byteLength,
    width: 16,
    height: 16,
  }),
})
assert.equal(storeConverted.adjustedImages[0]?.adjustment.mediaType, 'image/webp')
assert.equal(storeConverted.adjustedImages[0]?.adjustment.resized, false)

const animatedAllowed = await expandComposerMentions(fs, '/ws', '@animated.webp', {
  ...attachments,
  imageLimits: { ...attachments.imageLimits, mediaTypes: ['image/webp'] },
})
assert.deepEqual(animatedAllowed.animatedImagesRejected, [])
assert.deepEqual(animatedAllowed.adjustedImages, [])
assert.equal(saved.at(-1)?.data, animated)

const savedBeforeRejection = saved.length
const rejected = await expandComposerMentions(fs, '/ws', '@animated.webp', attachments)
assert.deepEqual(rejected.animatedImagesRejected, ['animated.webp'])
assert.equal(rejected.blocks.length, 1)
assert.equal(rejected.attached.length, 0)
assert.equal(saved.length, savedBeforeRejection)

console.log('mention image admission regression passed')
