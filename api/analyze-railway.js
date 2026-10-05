const { loadEnhancedData, loadEmbeddings, getCourseName } = require('./data-loader');
const { hybridSearch, probeEmbeddings } = require('./search');
const { extractQuestions, analyzeWithContext, getResolvedModels, maxTokensForQuestions, probeClaude } = require('./claude-client');
const { parseQuestionsWithStats } = require('./question-parser');
const {
    lookupQuestions,
    buildHaikuVerificationPrompt,
    parseHaikuResponse
} = require('./question-bank');
const {
    buildExtractionPrompt,
    buildAnalysisPrompt,
    buildRagContextWithStats,
    stripLeadingNum,
    parseAnswers
} = require('./response-builder');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'GET') {
        const apiKey = process.env.ANTHROPIC_API_KEY_EVO;
        const data = await loadEnhancedData();

        // Verifica attiva degli embeddings, ma solo su richiesta esplicita
        // (?check=embeddings): questa stessa rotta e' il warm-up che il
        // frontend chiama a ogni avvio, e non deve spendere una chiamata a
        // OpenAI ogni volta che apri l'app.
        // Qualunque valore di ?check esegue TUTTE le sonde, in parallelo: una
        // chiamata minima per servizio, per sapere se rispondono davvero e non
        // solo se la chiave e' impostata. Restano fuori dal warm-up, che questa
        // stessa rotta serve a ogni avvio dell'app.
        let embeddings = null, claude = null;
        if (req.query?.check) {
            [embeddings, claude] = await Promise.all([
                probeEmbeddings(),
                probeClaude(apiKey)
            ]);
        }

        return res.status(200).json({
            status: 'active',
            message: 'Quiz Assistant API - Railway Edition',
            apiKeyConfigured: !!apiKey,
            // Which course is actually serving answers — without this the
            // status looks healthy even when the wrong corpus is loaded.
            course: data?.courseName || getCourseName() || null,
            courseConfigured: !!getCourseName(),
            dataLoaded: !!data,
            chunksAvailable: data?.textChunks?.length || 0,
            // Which model each tier resolved to: a retired model id used to
            // surface as a generic "analysis failed".
            // Senza embeddings la ricerca ripiega sulle parole chiave senza
            // dire niente a nessuno: l'app risponde lo stesso, peggio. Qui la
            // chiave si vede gratis; se risponde davvero lo dice `embeddings`,
            // popolato solo con ?check=embeddings.
            embeddingsKeyConfigured: !!process.env.OPENAI_API_KEY,
            embeddings,
            claude,
            models: getResolvedModels()
        });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Declared outside the try so a failure can still report what was spent
    // before it: money charged by Anthropic on a call that succeeded before
    // the crash used to vanish from the counter.
    let totalCost = 0;

    try {
        const apiKey = process.env.ANTHROPIC_API_KEY_EVO;
        if (!apiKey) {
            return res.status(500).json({ error: 'ANTHROPIC_API_KEY_EVO non configurata' });
        }

        const startNumber = req.body.startNumber || 1;
        const extractionModelKey = 'sonnet';
        const analysisModelKey = req.body.precision === true ? 'opus' : 'sonnet';

        if (!req.body?.messages?.[0]?.content) {
            return res.status(400).json({ error: 'Formato richiesta non valido' });
        }

        const messageContent = req.body.messages[0].content;
        const imageContent = Array.isArray(messageContent)
            ? messageContent.find(c => c.type === 'image')
            : null;

        if (!imageContent?.source?.data) {
            return res.status(400).json({ error: 'Immagine non trovata o formato non valido' });
        }

        if (!getCourseName()) {
            return res.status(500).json({
                error: 'COURSE_NAME non configurata su Railway: impossibile sapere quale corso usare'
            });
        }

        const data = await loadEnhancedData();
        if (!data?.textChunks?.length) {
            return res.status(500).json({ error: 'Impossibile caricare il corso' });
        }

        const embeddingsData = await loadEmbeddings();

        // Step 1: Extract questions from image (always Sonnet)
        const extraction = await extractQuestions(apiKey, imageContent, buildExtractionPrompt(), extractionModelKey);
        const responseText = extraction.text;

        // Step 2: Parse questions
        const parsed = parseQuestionsWithStats(responseText);
        const questions = parsed.questions;
        if (questions.length === 0) {
            return res.status(400).json({
                error: 'Nessuna domanda estratta dall\'immagine. Assicurati che l\'immagine sia chiara e contenga domande.'
            });
        }
        if (parsed.dropped || parsed.illegible || parsed.truncated) {
            console.log(`[Extraction] ${questions.length} domande · ${parsed.dropped} scartate (illeggibili) · ${parsed.illegible} con opzioni parziali · ${parsed.truncated} oltre il limite`);
        }

        // Numbering: prefer the numbers printed on the quiz itself. They are
        // the only thing that lines the table up with the sheet in the user's
        // hands — positional numbering silently shifts as soon as a question
        // is dropped or the pages are photographed out of order. Only trust
        // them when the whole set is present, unique and increasing.
        const printed = questions.map(q => q.printedNumber);
        const usePrintedNumbers =
            printed.every(n => Number.isInteger(n) && n > 0) &&
            new Set(printed).size === printed.length &&
            printed.every((n, i) => i === 0 || n > printed[i - 1]);
        const numberOf = (i) => (usePrintedNumbers ? printed[i] : startNumber + i);
        console.log(`[Numbering] ${usePrintedNumbers ? 'numeri stampati sul quiz: ' + printed[0] + '-' + printed[printed.length - 1] : 'posizionale da ' + startNumber}`);

        // Step 2.5: Three-tier question bank lookup.
        // Must follow the course actually in use: with the course hardcoded,
        // a Marketing quiz was matched against the Organizzazione e Lavoro
        // bank (915 useless comparisons per request) and a future Marketing
        // bank would never have been consulted at all.
        const courseName = data.courseName || process.env.COURSE_NAME;
        const { direct, needsHaiku, unmatched } = lookupQuestions(questions, courseName);

        totalCost = extraction.cost || 0;
        const resolvedAnswers = {};  // num → { letter, source, analysis }

        // Come il contesto e' stato recuperato DAVVERO. Prima processingMethod
        // lo deduceva dalla presenza del file degli embeddings, quindi diceva
        // "semantic" anche quando la chiamata a OpenAI falliva e la ricerca
        // ripiegava sulle parole chiave - cioe' proprio nel caso che conta,
        // perche' peggiora le risposte senza sollevare un errore.
        const searchMethods = { semantic: 0, keyword: 0 };

        // Run one RAG pass over a set of question indices with a given model.
        // Shares the single prompt builder (response-builder) so the format
        // stays in lockstep with the parser. With forceAnswer=true the model
        // is told to never leave a question without a [CORRETTA] line — used
        // for the "?" recovery retry. Returns { answersByNum, blocksByNum }.
        const resolveWithRag = async (indices, modelKey, forceAnswer = false) => {
            const qs = indices.map(idx => questions[idx]);
            const nums = indices.map(idx => numberOf(idx));

            const searchResults = await hybridSearch(qs, data.textChunks, embeddingsData);
            searchResults.forEach(r => { searchMethods[r.searchMethod === 'semantic' ? 'semantic' : 'keyword']++; });
            const ragItems = qs.map((q, i) => ({ num: nums[i], result: searchResults[i] }));
            const { context: ragContext, stats } = buildRagContextWithStats(ragItems);
            console.log(
                `[RAG] ${qs.length} domande · ${stats.uniqueChunks} estratti unici su ${stats.totalRefs} riferimenti · ` +
                `${Math.round(stats.contextChars / 1000)}k char di contesto (formato precedente: ~${Math.round(stats.naiveChars / 1000)}k)` +
                (stats.droppedChunks ? ` · ${stats.droppedChunks} estratti oltre budget` : '')
            );

            const numberedQuestions = qs.map((q, i) => ({
                num: nums[i], text: q.text, options: q.options
            }));
            const ragPrompt = buildAnalysisPrompt(ragContext, numberedQuestions, { forceAnswer });

            const analysisResult = await analyzeWithContext(apiKey, ragPrompt, modelKey, { maxTokens: maxTokensForQuestions(qs.length) });
            totalCost += (analysisResult.cost || 0);

            // Pass the context so every "[CITATO]" claim is checked against
            // the material we actually sent: an invented quotation is demoted
            // to NON_VERIFICATA instead of reaching the user as a citation.
            const { answers: aiAnswers, analysisText } = parseAnswers(analysisResult.text, ragContext);

            // Split the RAG response into per-question blocks so each can be
            // stored next to its answer and re-ordered by question number.
            const blocksByNum = {};
            (analysisText || analysisResult.text)
                .split(/\n\s*---\s*\n/)
                .forEach(block => {
                    const m = block.match(/\*\*\s*(\d+)\./);
                    if (m) blocksByNum[parseInt(m[1], 10)] = block.trim();
                });

            return { answersByNum: aiAnswers, blocksByNum, model: analysisResult.model };
        };

        // Render an analysis block in the same format the RAG/UI expects:
        // **N. domanda** + opzioni con [CORRETTA] sulla risposta giusta + spiegazione.
        const renderBankBlock = (num, q, correctLetter, explanation, tag) => {
            let block = `**${num}. ${stripLeadingNum(q.text)}**\n\n`;
            ['A', 'B', 'C', 'D'].forEach(L => {
                if (q.options?.[L]) {
                    block += `${L}) ${q.options[L]}${L === correctLetter ? ' [CORRETTA]' : ''}\n`;
                }
            });
            block += `\nSpiegazione: ${explanation} ${tag}`;
            return block;
        };

        // --- Tier 1: Direct matches (mechanical remap, zero cost) ---
        direct.forEach(({ questionIndex, score, bankMatch, remappedLetter }) => {
            const num = numberOf(questionIndex);
            resolvedAnswers[num] = {
                letter: remappedLetter,
                source: 'QuestionBank',
                analysis: renderBankBlock(
                    num, questions[questionIndex], remappedLetter,
                    bankMatch.explanation, `[Question Bank – ${Math.round(score * 100)}% match]`
                )
            };
        });
        console.log(`[QuestionBank] Tier 1 (direct): ${direct.length} questions`);

        // --- Tier 2: Haiku verification (low cost, semantic matching) ---
        if (needsHaiku.length > 0) {
            console.log(`[QuestionBank] Tier 2 (Haiku): ${needsHaiku.length} questions`);
            try {
                const haikuPrompt = buildHaikuVerificationPrompt(needsHaiku, questions, startNumber);
                const haikuResult = await analyzeWithContext(apiKey, haikuPrompt, 'haiku', { maxTokens: maxTokensForQuestions(needsHaiku.length) });
                totalCost += (haikuResult.cost || 0);

                const haikuAnswers = parseHaikuResponse(haikuResult.text, needsHaiku, questions, startNumber);

                needsHaiku.forEach(({ questionIndex, score, bankMatch }) => {
                    const num = numberOf(questionIndex);
                    const haikuAnswer = haikuAnswers.get(num);

                    if (haikuAnswer) {
                        resolvedAnswers[num] = {
                            letter: haikuAnswer.letter,
                            source: 'QuestionBank+Haiku',
                            analysis: renderBankBlock(
                                num, questions[questionIndex], haikuAnswer.letter,
                                haikuAnswer.explanation, `[Question Bank + Haiku – ${Math.round(score * 100)}% match]`
                            )
                        };
                    } else {
                        // Haiku said NO_MATCH — demote to Tier 3
                        unmatched.push(questionIndex);
                    }
                });
            } catch (err) {
                console.error('[QuestionBank] Haiku verification failed, falling back to RAG:', err.message);
                // On Haiku failure, demote all to Tier 3
                needsHaiku.forEach(({ questionIndex }) => unmatched.push(questionIndex));
            }
        }

        // --- Tier 3: Full RAG pipeline (unmatched questions) ---
        console.log(`[QuestionBank] Tier 3 (RAG): ${unmatched.length} questions`);

        let usedModel = 'question-bank';

        if (unmatched.length > 0) {
            // First RAG pass over all unmatched questions.
            const { answersByNum, blocksByNum, model } = await resolveWithRag(unmatched, analysisModelKey);
            usedModel = model;

            unmatched.forEach(idx => {
                const num = numberOf(idx);
                if (!resolvedAnswers[num]) {
                    const answer = answersByNum[num] || { letter: '?', source: 'AI' };
                    resolvedAnswers[num] = {
                        letter: answer.letter,
                        source: answer.source,
                        analysis: blocksByNum[num] || ''
                    };
                }
            });

            // --- Recupero delle risposte incerte ---
            // Due casi, non uno solo. Il primo e' la domanda rimasta senza
            // lettera; da quando max_tokens non tronca piu' la risposta e'
            // diventato raro. Il secondo, molto piu' frequente, e' la risposta
            // marcata "AI": il modello dichiara che nel contesto la risposta non
            // c'e' e sceglie comunque. Li' non sta leggendo, sta ricordando, ed
            // e' esattamente il terreno su cui Opus e' misurabilmente piu' forte.
            //
            // Misurato su cento domande d'esame senza alcun corpus: Sonnet 93,
            // Opus 96, e nel confronto appaiato Opus vince tre volte e non perde
            // mai. Sulle sei domande che la pipeline aveva marcato "AI", Opus da
            // solo le prende tutte e sei contro cinque, compresa l'unica che il
            // RAG completo sbagliava. Sono il 6% delle domande che arrivano al
            // RAG, quindi su un foglio d'esame si parla di una chiamata in piu'.
            // Si tiene traccia del motivo per cui una domanda entra nel
            // recupero: cambia come va etichettata la risposta che ne esce.
            const enteredAsAI = new Set();
            const stillUnknown = unmatched.filter(idx => {
                const r = resolvedAnswers[numberOf(idx)];
                if (!r || r.letter === '?') return true;
                if (r.source === 'AI') { enteredAsAI.add(idx); return true; }
                return false;
            });

            if (stillUnknown.length > 0) {
                // Si sale a Opus. Da notare che il vecchio motivo scritto qui -
                // "a temperatura 0 lo stesso modello ridarebbe output identico"
                // - non vale piu': Sonnet 5 rifiuta il parametro temperature e
                // il client lo toglie, quindi due chiamate differiscono comunque.
                // La ragione per salire resta, ma e' un'altra: sulle domande che
                // il contesto non copre, Opus sa di piu'.
                const retryModel = 'opus';
                console.log(`[Recovery] Retrying ${stillUnknown.length} unresolved question(s) with ${retryModel} + forceAnswer`);
                try {
                    const retry = await resolveWithRag(stillUnknown, retryModel, true);
                    stillUnknown.forEach(idx => {
                        const num = numberOf(idx);
                        const answer = retry.answersByNum[num];
                        if (answer && answer.letter !== '?') {
                            // Chi e' entrato qui perche' marcato "AI" resta "AI",
                            // qualunque etichetta produca il secondo passaggio.
                            // Quella domanda e' arrivata a Opus proprio perche' il
                            // contesto non la copriva, e il controllo sulle
                            // citazioni verifica che la frase citata esista nel
                            // materiale, non che sostenga la risposta: sulla
                            // domanda 17 del foglio di prova il modello ha citato
                            // un passo autentico su Porter e le strategie
                            // competitive per rispondere sulla teoria del valore
                            // condiviso, che nel contesto non c'era. Etichettarla
                            // "CITATO" direbbe al lettore piu' di quanto sappiamo.
                            const source = enteredAsAI.has(idx)
                                ? 'AI'
                                : (answer.source || 'AI');
                            resolvedAnswers[num] = {
                                letter: answer.letter,
                                source,
                                analysis: retry.blocksByNum[num] || resolvedAnswers[num]?.analysis || ''
                            };
                        }
                    });
                    usedModel = retry.model || usedModel;
                } catch (err) {
                    console.error('[Recovery] Retry failed:', err.message);
                }
            }
        }

        // Build final response — table source and analysis both come from the
        // same per-question entry, assembled strictly in question-number order.
        const finalAnswersArray = questions.map((q, i) => {
            const num = numberOf(i);
            const resolved = resolvedAnswers[num] || { letter: '?', source: 'unknown' };
            return { num, letter: resolved.letter, source: resolved.source };
        });

        const analysisParts = finalAnswersArray
            .map(a => resolvedAnswers[a.num]?.analysis)
            .filter(Boolean);

        const bankResolved = direct.length + needsHaiku.filter(h => resolvedAnswers[numberOf(h.questionIndex)]?.source?.includes('Haiku')).length;

        res.status(200).json({
            answers: finalAnswersArray,
            analysis: analysisParts.join('\n---\n'),
            metadata: {
                model: unmatched.length > 0 ? usedModel : (needsHaiku.length > 0 ? 'haiku' : 'question-bank'),
                processingMethod: unmatched.length === 0
                    ? (needsHaiku.length > 0 ? 'question-bank+haiku' : 'question-bank')
                    : (searchMethods.semantic && searchMethods.keyword ? 'mixed-search-railway'
                        : searchMethods.semantic ? 'semantic-search-railway'
                        : 'keyword-search-railway'),
                searchMethods,
                searchStats: {
                    tier1_direct: direct.length,
                    tier2_haiku: bankResolved - direct.length,
                    tier3_rag: unmatched.length,
                    total: questions.length
                },
                chunksSearched: data.textChunks.length,
                embeddingsLoaded: !!embeddingsData,
                questionsAnalyzed: questions.length,
                // What the OCR step had to throw away, so the UI can say so
                // instead of silently showing fewer rows than the quiz has.
                extraction: {
                    droppedQuestions: parsed.dropped,
                    partialQuestions: parsed.illegible,
                    truncatedQuestions: parsed.truncated
                },
                numbering: usePrintedNumbers ? 'printed' : 'positional',
                cost: totalCost
            }
        });

    } catch (error) {
        const statusMap = {
            no_credits: 402,
            auth: 401,
            rate_limit: 429,
            model_unavailable: 503
        };
        const status = statusMap[error.kind] || 500;
        console.error(`[Analyze] fallita (${error.kind || 'unknown'}) dopo $${totalCost.toFixed(4)} di chiamate riuscite: ${error.message}`);
        res.status(status).json({
            error: error.message || 'Errore interno',
            kind: error.kind || 'unknown',
            // Calls that already succeeded were billed even though the request
            // failed: report them so the spend counter stays truthful.
            cost: totalCost,
            timestamp: new Date().toISOString()
        });
    }
};
