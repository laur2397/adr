import type { FastifyInstance } from 'fastify';
import { requireView } from '../access/policy.js';
import { userOf } from '../app.js';
import { getPool, maybeOne } from '../core/db.js';
import { notFound } from '../core/errors.js';
import { completeSignature, pendingForUser, signDocument } from './service.js';
import { signatureProvider } from './providers.js';

export async function signingRoutes(app: FastifyInstance) {
  app.get('/signatures/pending', async (req) => ({ items: await pendingForUser(userOf(req)) }));

  app.post<{ Params: { id: string; docKey: string } }>('/instances/:id/documents/:docKey/sign', async (req) => {
    const user = userOf(req);
    await requireView(getPool(), user, req.params.id);
    return signDocument(user, req.params.id, req.params.docKey);
  });

  app.get<{ Params: { id: string } }>('/signatures/:id', async (req) => {
    const user = userOf(req);
    const sig = await maybeOne(getPool(), `select * from signature where id = $1`, [req.params.id]);
    if (!sig?.instance_id) throw notFound('Semnătura');
    await requireView(getPool(), user, sig.instance_id);
    return sig;
  });

  /** Provider callback (remote QES). Authenticated by the provider adapter, not by a session. */
  app.post<{ Params: { provider: string } }>('/signatures/callback/:provider', async (req) => {
    const provider = signatureProvider();
    if (provider.name !== req.params.provider || !provider.handleCallback) throw notFound();
    const result = await provider.handleCallback(req.headers, req.body);
    if (!result) return { ok: true };
    const sig = await maybeOne(getPool(), `select id from signature where provider = $1 and provider_reference = $2 and status = 'pending'`, [
      provider.name,
      result.providerReference,
    ]);
    if (!sig) throw notFound('Semnătura');
    await completeSignature(sig.id, result.signedPdf, result.providerReference, result.format, {});
    return { ok: true };
  });
}
