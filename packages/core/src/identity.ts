/**
 * Identity-document checks shared by the upload function and the web app.
 * The file type is detected from the file's first bytes, not from its name.
 */
export const MAX_ID_IMAGE_BYTES = 7 * 1024 * 1024;
export type IdImageKind = "id_front" | "id_back" | "passport";
export type ImageType = "image/jpeg" | "image/png" | "image/heic";

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12) {
    const box = String.fromCharCode(...bytes.subarray(4, 8));
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (box === "ftyp" && ["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  return null;
}

/** Which images a document type needs before the cashier can verify. */
export function requiredImages(docType: "national_id" | "passport"): IdImageKind[] {
  return docType === "passport" ? ["passport"] : ["id_front", "id_back"];
}

export function missingImages(docType: "national_id" | "passport", uploaded: readonly IdImageKind[]): IdImageKind[] {
  return requiredImages(docType).filter((k) => !uploaded.includes(k));
}

/** Age on a given local date (YYYY-MM-DD strings). */
export function ageOn(dateOfBirth: string, onDate: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = onDate.split("-").map(Number) as [number, number, number];
  if (!by || !bm || !bd || !y) throw new Error("Invalid date");
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Names must match the document: letters, spaces, hyphens, apostrophes (accents allowed). */
export function isValidLegalName(s: string): boolean {
  return /^[\p{L}][\p{L}' -]{0,79}$/u.test(s.trim());
}
