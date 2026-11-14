/**
 * The master resume: read, download, replace, suggestions and restore.
 *
 * Moved verbatim from route() in src/dashboard/server.js. `ctx` exposes the
 * server's closure through getters, so `ctx.db` and `ctx.config` are always the
 * live values (they change when the active profile changes or config reloads).
 * Returns NOT_HANDLED when no route here matched, so server.js tries the next
 * module; anything else means the request was answered.
 */
import { MAX_UPLOAD_BODY_BYTES, readBody, sendJson } from '../httpHelpers.js';
import { NOT_HANDLED } from './notHandled.js';

export async function handleMasterResumeRoutes(ctx, req, res, { path }) {
  if (req.method === 'GET' && path === '/api/master-resume') {
    return sendJson(res, 200, ctx.masterResumeState());
  }
  if (req.method === 'GET' && path === '/api/master-resume/file') {
    const artifact = ctx.readMasterResumeFile();
    // A DOCX can never render in the browser, so it is always a download and
    // is locked down accordingly.
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    res.writeHead(200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-length': artifact.bytes.length,
      'content-disposition': `attachment; filename="${artifact.name.replace(/["\r\n]/g, '_')}"`,
    });
    res.end(artifact.bytes);
    return;
  }
  if (req.method === 'POST' && path === '/api/master-resume') {
    const body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
    const encoded = String(body.contentBase64 ?? '');
    if (!encoded) {
      return sendJson(res, 400, { error: 'no file contents were received' });
    }
    // Reject anything that is not strict base64 before decoding: Buffer.from
    // silently DISCARDS invalid characters, which would turn a mangled
    // upload into a plausible-looking but corrupt resume.
    if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) {
      return sendJson(res, 400, { error: 'the file contents were not transferred correctly, try again' });
    }
    const bytes = Buffer.from(encoded, 'base64');
    const result = ctx.replaceMasterResume({ filename: body.filename, bytes });
    // The whole point of the upload: say immediately whether this resume and
    // the saved search profile are describing the same job. Replacing the
    // file changes nothing about discovery on its own.
    return sendJson(res, 200, { ...result, suggestions: ctx.resumeSuggestions() });
  }
  // Role/skill evidence read out of the CURRENT master resume, next to what
  // discovery is actually searching for. Read-only: it proposes, and adopting
  // anything is a separate, explicit POST — see src/resume/resumeProfile.js
  // for why deriving targetTitles automatically would be wrong.
  if (req.method === 'GET' && path === '/api/master-resume/suggestions') {
    return sendJson(res, 200, ctx.resumeSuggestions());
  }
  if (req.method === 'POST' && path === '/api/master-resume/restore') {
    const body = await readBody(req);
    return sendJson(res, 200, ctx.restoreMasterResume(body.name));
  }
  return NOT_HANDLED;
}
