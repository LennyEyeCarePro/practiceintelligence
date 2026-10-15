/**
 * /api/lead - forwards a finished assessment's lead to PatientEngage.
 *
 * The page still writes every lead to its brand's Google Sheet exactly as before; this is the
 * second copy, inside PatientEngage (Practice Intelligence > Prospect leads). A lead is sent in two
 * parts, like the Sheet gets it: kind "lead" when the prospect submits, kind "seo" when the SEO scan
 * finishes. Both carry the same lead_id, generated in the browser, so PatientEngage puts them on one
 * row whichever arrives first.
 *
 * Why a server function instead of the browser calling PatientEngage: the request is signed
 * (X-PI-Lead-Signature = hex HMAC-SHA256 of the body) with PE_LEADS_SIGNING_KEY, and that key must
 * never be in the page.
 *
 * The brand is decided HERE from the host the page was served on (same rule as resolveBrand() in
 * index.html), never taken from the body - so a lead posted to the EyeCarePro front door cannot be
 * filed as Eyefinity's or the other way round.
 *
 * Env (Vercel project settings):
 *   PE_LEADS_URL          full URL of POST .../api/practice-intelligence/prospect-leads
 *   PE_LEADS_SIGNING_KEY  same value as PatientEngage's Integrations:PracticeIntelligence:LeadSigningKey
 * With either unset this accepts and drops the lead (the Sheet still has it), so deploying this
 * before PatientEngage is ready changes nothing for prospects.
 */
import crypto from 'node:crypto';

const MAX_BODY_BYTES = 200 * 1024;
const LEAD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function brandForHost(host) {
    const h = String(host || '').toLowerCase();
    return h.includes('eyefinity') ? 'Eyefinity' : 'EyeCarePro';
}

export function sign(key, body) {
    return crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');
}

/** The envelope PatientEngage expects, or a reason the request is refused. */
export function buildEnvelope(input, host, now = new Date()) {
    if (!input || typeof input !== 'object') return { error: 'body must be a JSON object' };
    const { lead_id: leadId, kind, payload } = input;
    if (typeof leadId !== 'string' || !LEAD_ID.test(leadId)) return { error: 'invalid lead_id' };
    if (kind !== 'lead' && kind !== 'seo') return { error: 'kind must be "lead" or "seo"' };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'payload must be an object' };
    return {
        envelope: {
            lead_id: leadId,
            kind,
            brand: brandForHost(host),
            sent_at: now.toISOString(),
            payload,
        },
    };
}

export default async function handler(req, res) {
    // Same-origin only: the page (and its iframe embeds) are served from this deployment, so no
    // CORS headers are sent and other sites' browsers cannot post here.
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? null);
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return res.status(413).json({ error: 'too large' });

    let input;
    try {
        input = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
        return res.status(400).json({ error: 'invalid JSON' });
    }

    const { envelope, error } = buildEnvelope(input, req.headers['x-forwarded-host'] || req.headers.host);
    if (error) return res.status(400).json({ error });

    const url = process.env.PE_LEADS_URL;
    const key = process.env.PE_LEADS_SIGNING_KEY;
    if (!url || !key) return res.status(202).json({ forwarded: false, reason: 'not_configured' });

    const body = JSON.stringify(envelope);
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-PI-Lead-Signature': sign(key, body) },
            body,
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) {
            console.warn(`[lead] PatientEngage answered ${resp.status} for ${envelope.kind} ${envelope.lead_id}`);
            return res.status(502).json({ forwarded: false, status: resp.status });
        }
        return res.status(202).json({ forwarded: true });
    } catch (e) {
        console.warn(`[lead] PatientEngage unreachable for ${envelope.kind} ${envelope.lead_id}: ${e.message}`);
        return res.status(502).json({ forwarded: false, reason: 'unreachable' });
    }
}
