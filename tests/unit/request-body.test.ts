import { describe, expect, it } from 'vitest';
import {
  readBodyBytes,
  readJsonBody,
  readJsonText,
  readMultipartFormData,
  RequestBodyError,
} from '../../functions/lib/request-body.ts';

function post(body: BodyInit, contentType = 'application/json'): Request {
  return new Request('https://example.com/api/test', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

describe('bounded request parsing', () => {
  it('accepts valid JSON with media-type parameters at the exact byte limit', async () => {
    const raw = '{"ok":true}';
    await expect(readJsonBody<{ ok: boolean }>(post(raw, 'application/json; charset=utf-8'), raw.length))
      .resolves.toEqual({ ok: true });
  });

  it('rejects CORS-safelisted text/plain before JSON parsing', async () => {
    await expect(readJsonBody(post('{}', 'text/plain'))).rejects.toMatchObject({
      code: 'unsupported_media_type',
      status: 415,
    });
  });

  it('rejects an oversized actual stream even without Content-Length', async () => {
    const request = post('x'.repeat(33));
    expect(request.headers.get('content-length')).toBeNull();
    await expect(readBodyBytes(request, 32)).rejects.toMatchObject({ code: 'too_large', status: 413 });
  });

  it('rejects a large declared length before reading the stream', async () => {
    const request = new Request('https://example.com/api/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '9999' },
      body: '{}',
    });
    await expect(readBodyBytes(request, 32)).rejects.toBeInstanceOf(RequestBodyError);
    await expect(readBodyBytes(new Request(request), 32)).rejects.toMatchObject({ status: 413 });
  });

  it('preserves exact raw webhook text and rejects invalid UTF-8', async () => {
    const raw = '{"id":"evt_1"}\n';
    await expect(readJsonText(post(raw), 1024)).resolves.toBe(raw);
    await expect(readJsonText(post(new Uint8Array([0xff])), 1024)).rejects.toMatchObject({ code: 'bad_body' });
  });

  it('bounds multipart overhead before parsing and returns the form when allowed', async () => {
    const form = new FormData();
    form.set('kind', 'damage');
    form.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])], 'test.jpg', { type: 'image/jpeg' }));
    const request = new Request('https://example.com/api/upload', { method: 'POST', body: form });
    const clone = request.clone();
    await expect(readMultipartFormData(request, 64)).rejects.toMatchObject({ status: 413 });
    const parsed = await readMultipartFormData(clone, 4096);
    expect(parsed.get('kind')).toBe('damage');
    expect(parsed.get('file')).toBeInstanceOf(File);
  });
});
