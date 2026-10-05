const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMS = 512;
// How many chunks we retrieve per question. The context builder consumes
// whatever it receives, so this is the single place that decides the depth.
const CHUNKS_PER_QUESTION = 4;

function cosineSimilarity(a, b) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embed several texts with a SINGLE OpenAI call.
 *
 * The API accepts an array as `input` and returns one vector per element,
 * so a 20-question quiz costs one round-trip instead of twenty sequential
 * ones. Returns an array aligned with `texts`, or null if unavailable.
 */
async function getQueryEmbeddings(texts) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey || !texts.length) return null;

    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiKey}`
            },
            body: JSON.stringify({
                model: EMBEDDING_MODEL,
                input: texts,
                dimensions: EMBEDDING_DIMS
            })
        });

        if (!response.ok) return null;

        const data = await response.json();
        if (!Array.isArray(data?.data)) return null;

        // The API may return items out of order — realign on `index`.
        const out = new Array(texts.length).fill(null);
        data.data.forEach(item => {
            const i = typeof item.index === 'number' ? item.index : 0;
            out[i] = item.embedding;
        });
        return out;
    } catch {
        return null;
    }
}


/**
 * Traduce la risposta di OpenAI in un motivo leggibile. 401 e 429 sono due
 * problemi diversi con due rimedi diversi - rifare la chiave contro ricaricare
 * il saldo - e confonderli manda a cercare nel posto sbagliato.
 */
function embeddingFailureReason(status, code, message) {
    if (code === 'insufficient_quota') return 'Credito OpenAI esaurito: ricarica il saldo';
    if (status === 401) return 'Chiave OpenAI non valida o revocata';
    if (status === 429) return 'Limite di frequenza raggiunto: troppe richieste ravvicinate';
    if (status === 403) return 'Accesso negato: permessi della chiave o regione non consentita';
    if (status === 404) return `Modello ${EMBEDDING_MODEL} non disponibile per questa chiave`;
    if (status >= 500) return 'Disservizio di OpenAI: riprova fra poco';
    return message || `OpenAI ha risposto ${status}`;
}

/**
 * Verifica diagnostica degli embeddings, per il pannello Stato.
 *
 * Volutamente separata da getQueryEmbeddings: nel percorso caldo serve solo
 * sapere si'/no e ripiegare in fretta, e infatti li' ogni errore diventa null.
 * Qui invece interessa il PERCHE', perche' il pannello deve dare una diagnosi
 * e non un sintomo: "non risponde" non dice se ricaricare il saldo o rifare
 * la chiave.
 */
async function probeEmbeddings() {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return { ok: false, ms: 0, reason: 'Chiave OPENAI_API_KEY non configurata' };

    const t0 = Date.now();
    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiKey}`
            },
            body: JSON.stringify({ model: EMBEDDING_MODEL, input: ['verifica'], dimensions: EMBEDDING_DIMS })
        });
        const ms = Date.now() - t0;
        if (response.ok) return { ok: true, ms, status: response.status };

        let code = '', message = '';
        try {
            const body = await response.json();
            code = body?.error?.code || '';
            message = body?.error?.message || '';
        } catch {}
        return { ok: false, ms, status: response.status, reason: embeddingFailureReason(response.status, code, message) };
    } catch (err) {
        return { ok: false, ms: Date.now() - t0, reason: `Rete non raggiungibile: ${err.message}` };
    }
}


// Il credito residuo non e' leggibile da qui, ed e' una strada gia' percorsa:
// `credit_grants` e' un endpoint della dashboard di OpenAI e alla chiave API di
// questo progetto risponde 403 (provato il 5 ottobre 2026). Anthropic non lo
// espone affatto senza una chiave di amministrazione dell'organizzazione, che
// su un server web non vale il rischio. Il presidio resta probeEmbeddings qui
// sopra - che dice se il servizio risponde ADESSO, l'unica cosa che conti
// davvero prima di un esame - piu' gli avvisi di soglia sugli account.

/**
 * Testo da cui si ricava l'embedding della query.
 *
 * Solo la domanda, senza le opzioni. Concatenarle sembrava dare al motore piu'
 * segnale, e invece gliene toglie: tre opzioni su quattro sono distrattori
 * scritti apposta per essere plausibili, e trascinano il vettore verso il
 * materiale sbagliato. Misurato sulle trenta domande di marketing-eval.json,
 * che portano l'id del chunk da cui sono state scritte: il chunk giusto entra
 * nei primi quattro 26 volte su 30 con le opzioni, 28 su 30 senza. Costa anche
 * meno token, non di piu'.
 */
function buildQueryText(question) {
    return (question.text || '').trim();
}

/**
 * Rank all course chunks against one query embedding (pure CPU, ~0.25ms
 * per question over 300 chunks — measured, not a bottleneck).
 *
 * `sectionById` re-attaches the section title: embeddings.json only stores
 * id/text/keywords, so without this join every semantic hit would reach the
 * prompt without a citable section and the model could not honour the
 * "[Sez. X.Y]" instruction.
 */
function rankChunks(queryEmbedding, embeddingsData, topK, sectionById) {
    const similarities = embeddingsData.chunks.map(chunk => ({
        chunk,
        similarity: cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    similarities.sort((a, b) => b.similarity - a.similarity);

    return similarities.slice(0, topK).map(s => ({
        chunk: {
            id: s.chunk.id,
            text: s.chunk.text,
            section: s.chunk.section || sectionById?.get(s.chunk.id),
            page: s.chunk.page,
            pages: s.chunk.pages,
            keywords: s.chunk.keywords
        },
        score: Math.round(s.similarity * 100),
        similarity: s.similarity,
        page: s.chunk.page
    }));
}

// id -> section, built once per request from the text chunks (which do carry
// the section) so semantic hits can be labelled for citation.
function buildSectionIndex(chunks) {
    const map = new Map();
    (chunks || []).forEach(c => {
        if (c?.id && c.section) map.set(c.id, c.section);
    });
    return map;
}

// Kept for backwards compatibility / single-question callers.
async function semanticSearch(questionText, options, embeddingsData, topK = CHUNKS_PER_QUESTION) {
    const embeddings = await getQueryEmbeddings([buildQueryText({ text: questionText, options })]);
    if (!embeddings?.[0]) return null;
    return rankChunks(embeddings[0], embeddingsData, topK);
}

const STOP_WORDS = ['della', 'delle', 'sono', 'quale', 'quali', 'come'];
const MIN_KEYWORD_SCORE = 30;
const MIN_KEYWORD_MATCHES = 3;

function keywordSearch(question, chunks) {
    const keywords = [];

    const questionWords = question.text.toLowerCase()
        .replace(/[^\w\sàèéìòù]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 3 && !STOP_WORDS.includes(word));

    keywords.push(...questionWords);

    Object.values(question.options || {}).forEach(option => {
        const optionWords = option.toLowerCase()
            .replace(/[^\w\sàèéìòù]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 4);
        keywords.push(...optionWords.slice(0, 3));
    });

    const uniqueKeywords = [...new Set(keywords)].slice(0, 10);
    const matches = [];

    chunks.forEach(chunk => {
        const text = chunk.text.toLowerCase();
        let score = 0;

        uniqueKeywords.forEach(keyword => {
            if (text.includes(keyword)) {
                score += 10;
                if (text.includes(keyword + ' ') || text.includes(' ' + keyword)) {
                    score += 5;
                }
            }
        });

        const matchCount = uniqueKeywords.filter(k => text.includes(k)).length;

        if (matchCount >= MIN_KEYWORD_MATCHES && score >= MIN_KEYWORD_SCORE) {
            matches.push({ chunk, score, matchCount, page: chunk.page });
        }
    });

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 3);
}

/**
 * Retrieve context for every question.
 *
 * All query embeddings are fetched in ONE batched call; the per-question
 * ranking that follows is synchronous. Questions whose semantic search
 * yields nothing fall back to keyword search individually.
 */
async function hybridSearch(questions, chunks, embeddingsData) {
    const canUseSemantic = !!embeddingsData?.chunks?.length && !!process.env.OPENAI_API_KEY;

    let queryEmbeddings = null;
    if (canUseSemantic) {
        const t0 = Date.now();
        queryEmbeddings = await getQueryEmbeddings(questions.map(buildQueryText));
        if (queryEmbeddings) {
            console.log(`[Search] ${questions.length} query embeddings in 1 batched call (${Date.now() - t0}ms)`);
        } else {
            console.warn('[Search] Batched embedding failed — falling back to keyword search');
        }
    }

    const sectionById = buildSectionIndex(chunks);

    return questions.map((question, i) => {
        let matches = [];

        if (queryEmbeddings?.[i]) {
            matches = rankChunks(queryEmbeddings[i], embeddingsData, CHUNKS_PER_QUESTION, sectionById);
        }

        if (matches.length === 0) {
            matches = keywordSearch(question, chunks);
        }

        return {
            question,
            matches,
            searchMethod: matches.length > 0 && matches[0].similarity ? 'semantic' : 'keyword'
        };
    });
}

module.exports = {
    hybridSearch,
    probeEmbeddings,
    keywordSearch,
    semanticSearch,
    getQueryEmbeddings,
    CHUNKS_PER_QUESTION
};
