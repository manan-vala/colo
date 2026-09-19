import { LIMITS, isImageType } from "../../../shared/protocol";
import { fitWithin } from "./size";

/**
 * Shrinks an image in the browser before upload (plan §2.3): longest side at most 2048 px and
 * at most 1 MB, as WebP (JPEG where the browser cannot encode WebP). Images that already fit are
 * uploaded untouched, so screenshots stay sharp and GIFs keep their animation.
 */

export interface PreparedImage {
  blob: Blob;
  /** Pixel size of `blob`, stored on the image node so its space is reserved before it loads. */
  width: number;
  height: number;
}

const QUALITIES = [0.85, 0.72, 0.58, 0.45];

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file is not an image this browser can read.");
  }
  try {
    const natural = { width: bitmap.width, height: bitmap.height };
    const fits = Math.max(natural.width, natural.height) <= LIMITS.imageMaxSide;
    if (isImageType(file.type) && file.size <= LIMITS.imageBytes && fits) return { blob: file, ...natural };

    let size = fitWithin(natural.width, natural.height, LIMITS.imageMaxSide);
    for (let attempt = 0; attempt < 4; attempt++) {
      for (const quality of QUALITIES) {
        const blob = await encode(bitmap, size, quality);
        if (blob.size <= LIMITS.imageBytes) return { blob, ...size };
      }
      // Still too large at the lowest quality (very detailed images): try a smaller size.
      size = fitWithin(size.width, size.height, Math.max(size.width, size.height) * 0.75);
    }
    throw new Error("That image is too detailed to fit in 1 MB.");
  } finally {
    bitmap.close();
  }
}

async function encode(bitmap: ImageBitmap, size: { width: number; height: number }, quality: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot resize images.");
  const type = (await supportsWebp()) ? "image/webp" : "image/jpeg";
  if (type === "image/jpeg") {
    // JPEG has no transparency; paint what would show through white, like the page.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded."))), type, quality),
  );
}

let webp: Promise<boolean> | undefined;

/** Safari draws WebP but encodes PNG when asked for WebP; check once what we actually get. */
function supportsWebp(): Promise<boolean> {
  webp ??= new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    canvas.toBlob((blob) => resolve(blob?.type === "image/webp"), "image/webp");
  });
  return webp;
}
