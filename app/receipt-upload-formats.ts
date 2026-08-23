export const RECEIPT_UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
] as const;

const allowedReceiptContentTypes = new Set<string>(RECEIPT_UPLOAD_CONTENT_TYPES);
const receiptImageContentTypes = new Set<string>(
  RECEIPT_UPLOAD_CONTENT_TYPES.filter((contentType) => contentType.startsWith("image/")),
);

const receiptContentTypeByExtension: Record<string, (typeof RECEIPT_UPLOAD_CONTENT_TYPES)[number]> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
};

export function receiptUploadContentType(file: { name?: string; type?: string }) {
  const declared = file.type?.trim().toLowerCase() ?? "";
  const normalizedDeclared = declared === "image/jpg" ? "image/jpeg" : declared;
  if (allowedReceiptContentTypes.has(normalizedDeclared)) return normalizedDeclared;

  const extension = file.name?.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? receiptContentTypeByExtension[extension] ?? null : null;
}

export function isReceiptUploadContentType(contentType: string) {
  return allowedReceiptContentTypes.has(contentType.trim().toLowerCase());
}

export function isReceiptImageContentType(contentType: string) {
  return receiptImageContentTypes.has(contentType.trim().toLowerCase());
}
