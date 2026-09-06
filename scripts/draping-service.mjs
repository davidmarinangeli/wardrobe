import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildDrapePath, drapeDefs, DRAPE_GROUND, DRAPE_SETS, findCandidate } from "../shared/draping.mjs";

export { DRAPE_SETS, findCandidate };

const SUBJECT_WIDTH = 760;
const SUBJECT_HEIGHT = 950;
const SUBJECT_FILE = "subject.webp";
const MANIFEST_FILE = "subject.json";

/**
 * Finds the narrowest point of the silhouette below the face — the neck — and
 * how wide it is there. The drape's neckline is hung from these, so it closes
 * around the throat of whoever's in the photo instead of a fixed percentage.
 */
async function detectNeck(pngBuffer) {
  const width = 190;
  const height = 250;
  const { data } = await sharp(pngBuffer)
    .resize(width, height, { fit: "fill" })
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const spanAt = (y) => {
    let first = -1;
    let last = -1;
    for (let x = 0; x < width; x += 1) {
      if (data[y * width + x] > 128) {
        if (first < 0) first = x;
        last = x;
      }
    }
    return { first, last, count: first < 0 ? 0 : last - first + 1 };
  };

  let narrowest = null;
  for (let y = Math.round(height * 0.55); y < Math.round(height * 0.92); y += 1) {
    const span = spanAt(y);
    if (span.count > 0 && (!narrowest || span.count <= narrowest.count)) {
      narrowest = { ...span, y };
    }
  }

  // A full-bleed photo with no cut-out has no waist to find; fall back to the
  // proportions of an average head-and-shoulders crop.
  if (!narrowest || narrowest.count >= width * 0.95) {
    return { y: 0.78, left: 0.32, right: 0.68, detected: false };
  }

  return {
    y: narrowest.y / height,
    left: narrowest.first / width,
    right: (narrowest.last + 1) / width,
    detected: true,
  };
}

async function loadPortraitSource(root) {
  const facePath = process.env.WARDROBE_FACE_REFERENCE
    ? path.resolve(root, process.env.WARDROBE_FACE_REFERENCE)
    : path.resolve(root, "data/model-reference-face.png");

  try {
    const stat = await fs.stat(facePath);
    return { file: facePath, stat, isFaceReference: true };
  } catch {}

  const modelPath = process.env.WARDROBE_MODEL_REFERENCE
    ? path.resolve(root, process.env.WARDROBE_MODEL_REFERENCE)
    : path.resolve(root, "data/model-reference.png");
  try {
    const stat = await fs.stat(modelPath);
    return { file: modelPath, stat, isFaceReference: false };
  } catch {}

  throw new Error("No face or model reference photo found in the data directory");
}

/**
 * Normalises the reference photo into the portrait the drape hangs on, and
 * writes it once to `outputDir`. Re-runs only when the source photo changes —
 * the browser recolours the drape itself, so nothing else needs rasterising.
 */
export async function prepareSubject(root, outputDir) {
  const source = await loadPortraitSource(root);
  const signature = `${source.file}:${source.stat.mtimeMs}:${source.stat.size}:v2`;
  const manifestPath = path.join(outputDir, MANIFEST_FILE);

  try {
    const cached = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (cached.signature === signature) {
      await fs.access(path.join(outputDir, SUBJECT_FILE));
      return cached;
    }
  } catch {}

  await fs.mkdir(outputDir, { recursive: true });

  const metadata = await sharp(source.file).metadata();
  // Trim the dead headroom above the hair so the face fills the frame.
  const trimTop = Math.round((metadata.height || 0) * 0.03);
  let pipeline = sharp(source.file);
  if (trimTop > 0 && metadata.width && metadata.height) {
    pipeline = pipeline.extract({
      left: 0,
      top: trimTop,
      width: metadata.width,
      height: metadata.height - trimTop,
    });
  }

  // WebP keeps the alpha the cut-out needs at a fraction of PNG's weight, and
  // this file is fetched every time the drape view opens.
  const portrait = await pipeline
    .resize(SUBJECT_WIDTH, SUBJECT_HEIGHT, { fit: "cover", position: "top" })
    .webp({ quality: 92 })
    .toBuffer();

  const neck = metadata.hasAlpha
    ? await detectNeck(portrait)
    : { y: 0.78, left: 0.32, right: 0.68, detected: false };

  await fs.writeFile(path.join(outputDir, SUBJECT_FILE), portrait);

  const manifest = {
    signature,
    url: `/drapes/${SUBJECT_FILE}`,
    width: SUBJECT_WIDTH,
    height: SUBJECT_HEIGHT,
    ground: DRAPE_GROUND,
    neck,
    isFaceReference: source.isFaceReference,
    // The photo is a cut-out, so the drape can be laid over a neutral ground.
    // A rectangular photo gets the drape too, it just keeps its own background.
    hasCutout: !!metadata.hasAlpha,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

/** The drape overlay as standalone SVG — the same shape the browser draws. */
export function drapeOverlaySvg(width, height, neck, color) {
  const outline = buildDrapePath(width, height, neck);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>${drapeDefs("srv")}<clipPath id="srv-clip"><path d="${outline}"/></clipPath></defs>
  <path d="${outline}" fill="${color}" filter="url(#srv-lift)"/>
  <g clip-path="url(#srv-clip)">
    <rect width="${width}" height="${height}" fill="${color}"/>
    <rect width="${width}" height="${height}" fill="url(#srv-sheen)"/>
    <rect width="${width}" height="${height}" fill="url(#srv-fold)"/>
  </g>
</svg>`;
}

/**
 * Flattens the portrait under one fabric colour. Only used when a comparison is
 * sent to the vision model — the interactive view never needs this.
 */
export async function renderDrapedPortrait(root, outputDir, color) {
  const subject = await prepareSubject(root, outputDir);
  const portrait = await fs.readFile(path.join(outputDir, SUBJECT_FILE));
  const overlay = Buffer.from(
    drapeOverlaySvg(subject.width, subject.height, subject.neck, color)
  );

  return sharp({
    create: {
      width: subject.width,
      height: subject.height,
      channels: 3,
      background: subject.hasCutout ? DRAPE_GROUND : "#ffffff",
    },
  })
    .composite([{ input: portrait, top: 0, left: 0 }, { input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}
