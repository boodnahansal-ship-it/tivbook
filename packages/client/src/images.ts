/**
 * Prepares an ID photo for upload: photos are resized (max 1400 px) and re-encoded as
 * JPEG (~200 KB) — small on mobile data and in the free storage allowance. HEIC files that the
 * browser cannot decode are sent as-is (the server accepts HEIC).
 */
export async function prepareIdImage(file: File, maxSide = 1400, quality = 0.72): Promise<{ base64: string; previewUrl: string; bytes: number }> {
  const original = await fileToBase64(file);
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
    if (!blob) throw new Error("encode failed");
    const base64 = await fileToBase64(blob);
    return { base64, previewUrl: URL.createObjectURL(blob), bytes: blob.size };
  } catch {
    // Browser can't decode (e.g. HEIC on Android/Windows): upload the original.
    return { base64: original, previewUrl: "", bytes: file.size };
  }
}

function fileToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
