import { errorJson } from './util.ts';

export const REQUEST_BODY_LIMITS = {
  json: 32 * 1024,
  event: 8 * 1024,
  vin: 4 * 1024,
  stripeWebhook: 1024 * 1024,
} as const;

export class RequestBodyError extends Error {
  constructor(
    readonly code: 'unsupported_media_type' | 'too_large' | 'bad_body',
    readonly status: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

function mediaType(request: Request): string {
  return (request.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

function requireMediaType(request: Request, expected: string): string {
  const actual = mediaType(request);
  if (actual !== expected) {
    throw new RequestBodyError(
      'unsupported_media_type',
      415,
      `Content-Type must be ${expected}.`,
    );
  }
  return request.headers.get('content-type') ?? expected;
}

export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared.trim())) {
      throw new RequestBodyError('bad_body', 400, 'Content-Length is invalid.');
    }
    if (Number(declared) > maxBytes) {
      throw new RequestBodyError('too_large', 413, 'Request body is too large.');
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      void reader.cancel('request body exceeds configured limit');
      throw new RequestBodyError('too_large', 413, 'Request body is too large.');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody<T>(request: Request, maxBytes = REQUEST_BODY_LIMITS.json): Promise<T> {
  requireMediaType(request, 'application/json');
  const bytes = await readBodyBytes(request, maxBytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return JSON.parse(text) as T;
  } catch {
    throw new RequestBodyError('bad_body', 400, 'Request body must be valid JSON.');
  }
}

export async function readJsonText(request: Request, maxBytes: number): Promise<string> {
  requireMediaType(request, 'application/json');
  const bytes = await readBodyBytes(request, maxBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new RequestBodyError('bad_body', 400, 'Request body must be valid UTF-8.');
  }
}

export async function readMultipartFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  requireMediaType(request, 'multipart/form-data');
  const bytes = await readBodyBytes(request, maxBytes);
  try {
    return await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new RequestBodyError('bad_body', 400, 'Request body must be valid multipart form data.');
  }
}

export function requestBodyErrorResponse(error: unknown): Response {
  if (error instanceof RequestBodyError) {
    return errorJson(error.code, error.message, error.status);
  }
  return errorJson('bad_body', 'Request body could not be read.', 400);
}
