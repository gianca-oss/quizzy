const MAX_RETRIES = 3;

// Anthropic retires models. When Sonnet 4 was withdrawn every analysis started
// failing instantly with "model: claude-sonnet-4-20250514" and the UI blamed a
// Railway cold start. So each tier is a CHAIN, newest first: on a not-found we
// move to the next candidate and remember the winner for the process lifetime.
const MODEL_CHAINS = {
    haiku: ['claude-haiku-4-5-20251001', 'claude-haiku-3-5-20241022'],
    sonnet: ['claude-sonnet-5', 'claude-sonnet-4-20250514'],
    opus: ['claude-opus-5', 'claude-opus-4-20250514']
};

// Resolved per tier once we know what this API key can actually reach.
const resolvedModel = {};

// Newer models reject `temperature` ("`temperature` is deprecated for this
// model"). Rather than hard-code which ones, we learn it: the first rejection
// makes us resend without the parameter and remember it for that model.
const rejectsTemperature = new Set();

function isTemperatureRejected(status, body) {
    if (status !== 400) return false;
    const lower = (body || '').toLowerCase();
    return lower.includes('temperature') && (lower.includes('deprecat') || lower.includes('not supported') || lower.includes('unsupported'));
}

// USD per million tokens, from Anthropic's published rates (July 2026).
// Unknown ids fall back to the Sonnet tier so the spend counter still gives
// an estimate rather than silently reporting zero.
const PRICING = {
    'claude-haiku-4-5-20251001': { input: 1, output: 5 },
    'claude-haiku-3-5-20241022': { input: 0.80, output: 4 },
    'claude-sonnet-5': { input: 2, output: 10 },      // promo rate, see below
    'claude-sonnet-4-20250514': { input: 3, output: 15 },
    'claude-opus-5': { input: 5, output: 25 },
    'claude-opus-4-20250514': { input: 15, output: 75 }
};

// Sonnet 5 launched at $2/$10; standard $3/$15 pricing starts 1 Sep 2026.
// Encoding the switch here means the counter stays honest on its own instead
// of quietly drifting once the promotion ends.
const SONNET5_STANDARD_PRICING_FROM = Date.UTC(2026, 8, 1);

function priceFor(model, when = Date.now()) {
    if (model === 'claude-sonnet-5' && when >= SONNET5_STANDARD_PRICING_FROM) {
        return { input: 3, output: 15 };
    }
    return PRICING[model] || { input: 3, output: 15 };
}

function computeCost(model, usage) {
    if (!usage) return 0;
    const p = priceFor(model);
    return (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1_000_000;
}

// "model: claude-sonnet-4-20250514" / not_found_error → this id is gone.
function isModelNotFound(status, body) {
    if (status !== 404 && status !== 400) return false;
    const lower = (body || '').toLowerCase();
    return lower.includes('not_found_error') || /"?model"?\s*:\s*"?claude/.test(lower);
}

/**
 * Send a request trying each candidate model for the tier until one is
 * accepted, so a retired model degrades to the next best instead of taking
 * the whole app down.
 */
async function callWithModelFallback(apiKey, modelKey, buildBody) {
    const chain = MODEL_CHAINS[modelKey] || MODEL_CHAINS.sonnet;
    const candidates = resolvedModel[modelKey] ? [resolvedModel[modelKey]] : chain;
    let lastResponse = null;
    let lastBody = '';

    const send = (model) => {
        const body = buildBody(model);
        // Drop parameters this model is known to reject.
        if (rejectsTemperature.has(model)) delete body.temperature;
        return callWithRetry('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: buildHeaders(apiKey),
            body: JSON.stringify(body)
        });
    };

    for (const model of candidates) {
        let response = await send(model);

        // Learn once that this model refuses `temperature`, then resend.
        if (!response.ok) {
            const body = await response.clone().text();
            if (isTemperatureRejected(response.status, body) && !rejectsTemperature.has(model)) {
                console.warn(`[Models] ${model} rifiuta "temperature": reinvio senza`);
                rejectsTemperature.add(model);
                response = await send(model);
            }
        }

        if (response.ok) {
            if (resolvedModel[modelKey] !== model) {
                console.log(`[Models] tier "${modelKey}" → ${model}`);
                resolvedModel[modelKey] = model;
            }
            return { response, model };
        }

        lastResponse = response;
        lastBody = await response.clone().text();

        if (isModelNotFound(response.status, lastBody)) {
            console.warn(`[Models] ${model} non disponibile, provo il successivo`);
            continue;
        }
        return { response, model };
    }

    // Every candidate is gone: surface it as a configuration problem, not as
    // a transient failure the user should "retry in a few seconds".
    const err = new Error(
        `Nessun modello disponibile per "${modelKey}". Provati: ${chain.join(', ')}. ` +
        `La API key non ha accesso a questi modelli o sono stati ritirati.`
    );
    err.kind = 'model_unavailable';
    err.status = lastResponse?.status || 404;
    err.detail = lastBody.substring(0, 200);
    throw err;
}

function getResolvedModels() {
    return { chains: MODEL_CHAINS, resolved: { ...resolvedModel } };
}

// Errors that won't be fixed by retrying — bail immediately to save cost & time.
function isPermanentError(status, body) {
    if (status === 401 || status === 402 || status === 403) return true;
    if (status === 400 && body) {
        const lower = body.toLowerCase();
        if (lower.includes('credit balance') || lower.includes('insufficient')) return true;
        if (lower.includes('invalid_api_key') || lower.includes('authentication')) return true;
    }
    return false;
}

async function callWithRetry(url, options) {
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const response = await fetch(url, options);

            // Don't retry permanent errors — peek at body once
            if (!response.ok) {
                const cloned = response.clone();
                const body = await cloned.text();
                if (isPermanentError(response.status, body)) {
                    return new Response(body, { status: response.status, statusText: response.statusText });
                }
            }

            if (response.status === 429) {
                const waitTime = Math.min(Math.pow(2, i) * 2000, 15000);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
            }

            // Only retry on 5xx (transient server issues)
            if (response.status >= 500 && response.status < 600) {
                if (i < MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }
            }

            return response;
        } catch (error) {
            // Network error — retry
            if (i === MAX_RETRIES - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

function buildHeaders(apiKey) {
    return {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
    };
}

/**
 * Pull the text out of an Anthropic response.
 *
 * Reading content[0].text assumed the first block is always text. Newer
 * models can put another block type first (e.g. thinking), which made the
 * field undefined and blew up the parser downstream with an opaque
 * "reading 'split'". Concatenate every text block instead.
 */
function textFromResponse(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('\n')
        .trim();
    if (text) return text;
    const kinds = blocks.map(b => b?.type || typeof b).join(', ') || 'nessun blocco';
    const err = new Error(`Risposta API senza testo utilizzabile (blocchi: ${kinds})`);
    err.kind = 'empty_response';
    throw err;
}

async function extractQuestions(apiKey, imageContent, prompt, modelKey = 'sonnet') {
    const { response, model } = await callWithModelFallback(apiKey, modelKey, (m) => ({
        model: m,
        // Stesso tetto dell'analisi, e per lo stesso motivo: il JSON di una
        // pagina densa - testo della domanda piu' quattro opzioni per venti
        // domande - supera comodamente i 4000 token, e quello che viene tagliato
        // sono le ultime domande della pagina. Qui non possiamo scalare col
        // numero di domande, perche' scoprirlo e' proprio il compito di questa
        // chiamata: si parte dal massimo che regge tutta la catena di fallback.
        // Vale anche qui il margine per il ragionamento: Sonnet 5 pensa per
        // impostazione predefinita, e il pensiero attinge allo stesso tetto.
        max_tokens: 16000,
        messages: [{
            role: 'user',
            content: [imageContent, { type: 'text', text: prompt }]
        }]
    }));

    if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Errore API Claude (${response.status})`;
        let errorKind = 'unknown';
        try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.error?.message || errorData.message || errorMessage;
        } catch {
            errorMessage += `: ${errorText.substring(0, 200)}`;
        }
        // Tag known permanent error categories so callers can react
        const lower = errorMessage.toLowerCase();
        if (lower.includes('credit balance') || lower.includes('insufficient')) errorKind = 'no_credits';
        else if (lower.includes('invalid_api_key') || lower.includes('authentication')) errorKind = 'auth';
        else if (response.status === 429) errorKind = 'rate_limit';
        const err = new Error(errorMessage);
        err.kind = errorKind;
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    return { text: textFromResponse(data), cost: computeCost(model, data.usage) };
}

/**
 * Tetto di token in uscita per una risposta che deve coprire N domande.
 *
 * Con il vecchio valore fisso di 4000, un lotto da dieci domande veniva
 * troncato: misurato su cento domande d'esame, zero risposte perse nelle
 * posizioni 1-8 del lotto e quattro perse in posizione 9 o 10. Le domande
 * troncate finivano poi nel giro di recupero con Opus, che costa cinque volte
 * tanto - si pagava un modello di punta per rimediare a un limite nostro.
 *
 * Il tetto di 8000 non e' prudenza generica: e' il massimo che accetta anche
 * l'ultimo anello della catena di fallback (Haiku 3.5 si ferma a 8192 token in
 * uscita), quindi un valore piu' alto romperebbe la richiesta proprio quando
 * siamo gia' ripiegati sul modello di riserva.
 */
// Il budget deve coprire il ragionamento, non solo la risposta. Su Opus 5 e
// Sonnet 5 il pensiero e' attivo per impostazione predefinita: omettere
// `thinking` non lo spegne piu' come faceva su Opus 4.8, che e' l'assunzione
// con cui questo numero era stato scelto. Con 4000 token Opus li consumava
// tutti ragionando e veniva troncato prima di scrivere una riga: il content
// tornava col solo blocco "thinking", da cui empty_response, 500, e un
// "Ritento" sul telefono - dopo aver gia' pagato estrazione e RAG.
function maxTokensForQuestions(count) {
    return Math.min(24000, Math.max(16000, 600 * (count || 1) + 16000));
}

async function analyzeWithContext(apiKey, prompt, modelKey = 'sonnet', opts = {}) {
    const maxTokens = opts.maxTokens || 16000;
    const { response, model } = await callWithModelFallback(apiKey, modelKey, (m) => ({
        model: m,
        max_tokens: maxTokens,
        messages: [{
            role: 'user',
            content: [{ type: 'text', text: prompt }]
        }]
    }));

    if (!response.ok) {
        const body = await response.text();
        let errorMessage = `Errore API Claude (${response.status})`;
        let errorKind = 'unknown';
        try {
            const parsed = JSON.parse(body);
            errorMessage = parsed.error?.message || parsed.message || errorMessage;
        } catch {}
        const lower = errorMessage.toLowerCase();
        if (lower.includes('credit balance') || lower.includes('insufficient')) errorKind = 'no_credits';
        else if (lower.includes('invalid_api_key') || lower.includes('authentication')) errorKind = 'auth';
        else if (response.status === 429) errorKind = 'rate_limit';
        const err = new Error(errorMessage);
        err.kind = errorKind;
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    return { text: textFromResponse(data), model, cost: computeCost(model, data.usage) };
}

module.exports = { extractQuestions, analyzeWithContext, getResolvedModels, maxTokensForQuestions, MODEL_CHAINS };
