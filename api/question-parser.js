const MAX_QUESTIONS = 30;

// The quiz sheet numbers its own questions ("5. La somministrazione..."). We
// strip that from the text to avoid rendering "5. 5. ...", but the number
// itself is worth keeping: it is the only thing that ties a row of the table
// back to the paper the user is holding.
const PRINTED_NUM = /^\s*(\d{1,3})[.)]\s+/;

function extractPrintedNumber(text) {
    const m = (text || '').match(PRINTED_NUM);
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Parse the extraction response, reporting what was discarded.
 *
 * Questions whose options came back unreadable used to disappear without a
 * trace: the table simply had fewer rows and every following number was off
 * by one against the printed sheet. The caller now learns how many were
 * dropped so it can say so.
 */
function parseQuestionsWithStats(responseText) {
    // Defence in depth: an upstream change that yields a non-string must not
    // crash the request with an opaque "reading 'split'".
    if (typeof responseText !== 'string' || !responseText.trim()) {
        return { questions: [], dropped: 0, illegible: 0, truncated: 0 };
    }
    let result = parseJSONWithStats(responseText);

    // I ripieghi non sanno contare gli scarti, quindi subentrano solo se
    // trovano davvero qualcosa. Sostituendo il risultato a scatola chiusa si
    // perdeva il conteggio del passaggio JSON proprio nel caso in cui serve:
    // una sola domanda aperta, scartata perche' priva di opzioni, elenco
    // vuoto - e il chiamante non poteva piu' distinguere "scartata" da
    // "immagine illeggibile", che per l'utente sono due rimedi diversi.
    if (result.questions.length === 0) {
        const bySeparators = parseWithSeparators(responseText);
        if (bySeparators.length > 0) result = { questions: bySeparators, dropped: 0, illegible: 0 };
    }

    if (result.questions.length === 0) {
        const alternative = parseAlternative(responseText);
        if (alternative.length > 0) result = { questions: alternative, dropped: 0, illegible: 0 };
    }

    let truncated = 0;
    if (result.questions.length > MAX_QUESTIONS) {
        truncated = result.questions.length - MAX_QUESTIONS;
        result.questions = result.questions.slice(0, MAX_QUESTIONS);
    }

    return { ...result, truncated };
}

function parseQuestions(responseText) {
    return parseQuestionsWithStats(responseText).questions;
}

function parseJSON(responseText) {
    return parseJSONWithStats(responseText).questions;
}

function parseJSONWithStats(responseText) {
    try {
        // 1. Strip markdown code fences if present (```json ... ```)
        let cleaned = responseText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1');
        // 2. Normalize "smart quotes" Opus sometimes emits into ASCII quotes
        cleaned = cleaned
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'");
        // 3. Extract first JSON object containing "questions"
        const jsonMatch = cleaned.match(/\{[\s\S]*"questions"[\s\S]*\}/);
        if (!jsonMatch) return { questions: [], dropped: 0, illegible: 0 };

        const data = JSON.parse(jsonMatch[0]);
        if (!data.questions || !Array.isArray(data.questions)) {
            return { questions: [], dropped: 0, illegible: 0 };
        }

        let dropped = 0;
        let illegible = 0;
        const questions = [];

        data.questions.forEach((q, index) => {
            if (!q.text || !q.options || Object.keys(q.options).length < 2) {
                dropped++;
                return;
            }

            // Drop empty / unreadable options so the analysis prompt doesn't
            // end up with a bare "B)" line, but remember that it happened.
            const cleanOptions = {};
            let hadIllegible = false;
            for (const [k, v] of Object.entries(q.options)) {
                const text = String(v || '').trim();
                if (text && text.toLowerCase() !== '[illeggibile]') {
                    cleanOptions[k] = text;
                } else {
                    hadIllegible = true;
                }
            }

            if (Object.keys(cleanOptions).length < 2) {
                dropped++;
                return;
            }
            if (hadIllegible) illegible++;

            const rawText = String(q.text).trim();
            questions.push({
                number: index + 1,
                printedNumber: extractPrintedNumber(rawText),
                text: rawText,
                options: cleanOptions,
                partial: hadIllegible
            });
        });

        return { questions, dropped, illegible };
    } catch {
        return { questions: [], dropped: 0, illegible: 0 };
    }
}

function parseWithSeparators(responseText) {
    const questions = [];
    const allBlocks = responseText.split(/---+/);
    const questionBlocks = allBlocks.filter(block =>
        block.includes('TESTO:') || block.includes('DOMANDA')
    );

    questionBlocks.forEach((block, index) => {
        const lines = block.trim().split('\n');
        const question = { number: index + 1, text: '', options: {} };

        lines.forEach(line => {
            line = line.trim();
            if (!line) return;

            if (line.toUpperCase().startsWith('TESTO:')) {
                question.text = line.substring(6).trim();
            } else if (/^A\s*[:)]/i.test(line)) {
                question.options.A = line.replace(/^A\s*[:)]\s*/i, '').trim();
            } else if (/^B\s*[:)]/i.test(line)) {
                question.options.B = line.replace(/^B\s*[:)]\s*/i, '').trim();
            } else if (/^C\s*[:)]/i.test(line)) {
                question.options.C = line.replace(/^C\s*[:)]\s*/i, '').trim();
            } else if (/^D\s*[:)]/i.test(line)) {
                question.options.D = line.replace(/^D\s*[:)]\s*/i, '').trim();
            }
        });

        if (question.text && Object.keys(question.options).length >= 2) {
            questions.push(question);
        }
    });

    return questions;
}

function parseAlternative(responseText) {
    const questions = [];
    const lines = responseText.split('\n');
    let currentQuestion = null;
    let questionNum = 0;

    lines.forEach(line => {
        line = line.trim();

        if (line.match(/^(?:DOMANDA[_ ]?\d+|(?:\d+)[.)\s])/i)) {
            if (currentQuestion?.text) {
                questions.push(currentQuestion);
            }
            questionNum++;
            currentQuestion = { number: questionNum, text: '', options: {} };
        } else if (currentQuestion) {
            if (!currentQuestion.text && line.length > 10 && !line.match(/^[A-D][):.]/i)) {
                currentQuestion.text = line;
            } else if (line.match(/^[A-D][):.]/i)) {
                const letter = line[0].toUpperCase();
                currentQuestion.options[letter] = line.substring(2).trim();
            }
        }
    });

    if (currentQuestion?.text) {
        questions.push(currentQuestion);
    }

    return questions;
}

module.exports = { parseQuestions, parseQuestionsWithStats, extractPrintedNumber };
