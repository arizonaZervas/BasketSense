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

export function isReceiptUploadContentType(contentType: string) {
  return allowedReceiptContentTypes.has(contentType.trim().toLowerCase());
}

export function isReceiptImageContentType(contentType: string) {
  return receiptImageContentTypes.has(contentType.trim().toLowerCase());
}
