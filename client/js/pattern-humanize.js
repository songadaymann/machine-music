// pattern-humanize.js -- Convert Strudel snippets into human-readable summaries
// and simple step timelines for the in-world arranger screen.

const DEFAULT_STEPS = 16;

function extractFirstQuotedArg(code, fnNames) {
    if (typeof code !== 'string' || !code) return null;
    for (const fn of fnNames) {
        const regex = new RegExp(`\\b${fn}\\s*\\(\\s*["']([^"']+)["']`, 'i');
        const match = code.match(regex);
        if (match?.[1]) return match[1];
    }
    return null;
}

function extractSoundSource(code) {
    if (typeof code !== 'string' || !code) return null;
    const soundMatch = code.match(/\.sound\s*\(\s*["']([^"']+)["']\s*\)/i);
    if (soundMatch?.[1]) return soundMatch[1];

    const shortMatch = code.match(/\.s\s*\(\s*["']([^"']+)["']\s*\)/i);
    if (shortMatch?.[1]) return shortMatch[1];

    return null;
}

function cleanToken(rawToken) {
    let token = (rawToken || '').trim();
    if (!token) return '';
    if (token === '~' || token === '-') return '~';

    token = token
        .replace(/[<>{}\[\]()]/g, '')
        .replace(/\*.+$/g, '')
        .replace(/:.+$/g, '')
        .replace(/[!?].*$/g, '')
        .trim();

    if (!token) return '';
    if (token === '~' || token === '-') return '~';
    return token.toLowerCase();
}

function tokenizePatternString(pattern) {
    if (typeof pattern !== 'string' || !pattern) return [];
    return pattern
        .replace(/[|,]/g, ' ')
        .split(/\s+/)
        .map(cleanToken)
        .filter((token) => token.length > 0);
}

function countActiveSteps(steps) {
    return steps.reduce((sum, step) => sum + (step.active ? 1 : 0), 0);
}

function describeDensity(activeCount, total) {
    if (!total) return 'silent';
    const ratio = activeCount / total;
    if (ratio >= 0.72) return 'dense';
    if (ratio >= 0.36) return 'steady';
    if (ratio > 0) return 'sparse';
    return 'silent';
}

function describeRegister(notes, fallbackRole) {
    if (!notes.length) return fallbackRole;
    const octaves = [];
    for (const note of notes) {
        const match = note.match(/[a-g][#b]?(-?\d+)/i);
        if (!match) continue;
        const octave = Number(match[1]);
        if (Number.isFinite(octave)) octaves.push(octave);
    }
    if (!octaves.length) return fallbackRole;
    const avg = octaves.reduce((sum, value) => sum + value, 0) / octaves.length;
    if (avg <= 2.4) return 'bassline';
    if (avg >= 4.8) return 'lead melody';
    return fallbackRole;
}

function pickUniqueTokens(tokens, max = 3) {
    const seen = new Set();
    const picked = [];
    for (const token of tokens) {
        if (token === '~' || seen.has(token)) continue;
        seen.add(token);
        picked.push(token);
        if (picked.length >= max) break;
    }
    return picked;
}

export function deriveStepGrid(code, slotType, totalSteps = DEFAULT_STEPS) {
    if (!code || typeof code !== 'string') {
        return {
            steps: Array.from({ length: totalSteps }, () => ({ active: false, token: '' })),
            tokens: [],
            sourceType: 'empty',
        };
    }

    const rhythmPattern = extractFirstQuotedArg(code, ['s']);
    const notePattern = extractFirstQuotedArg(code, ['note', 'n']);
    const sourcePattern = rhythmPattern || notePattern || '';
    const tokens = tokenizePatternString(sourcePattern);

    if (!tokens.length) {
        return {
            steps: Array.from({ length: totalSteps }, () => ({ active: false, token: '' })),
            tokens: [],
            sourceType: notePattern ? 'note' : slotType === 'drums' ? 'drum' : 'unknown',
        };
    }

    const steps = [];
    for (let i = 0; i < totalSteps; i++) {
        const token = tokens[i % tokens.length];
        const active = token !== '~' && token !== '-';
        steps.push({ active, token: active ? token : '' });
    }

    return {
        steps,
        tokens,
        sourceType: rhythmPattern ? (slotType === 'drums' ? 'drum' : 'rhythm') : 'note',
    };
}

export function humanizePattern(code, slotType = 'wild') {
    if (!code || typeof code !== 'string') return 'waiting_for_claim';

    const grid = deriveStepGrid(code, slotType, DEFAULT_STEPS);
    const activeCount = countActiveSteps(grid.steps);
    const density = describeDensity(activeCount, grid.steps.length);
    const source = extractSoundSource(code);
    const featured = pickUniqueTokens(grid.tokens, 3).join(' + ');

    if (slotType === 'drums' || grid.sourceType === 'drum' || grid.sourceType === 'rhythm') {
        const timbre = source ? ` (${source})` : '';
        const voice = featured || 'percussion';
        return `${density} ${voice} groove${timbre}`;
    }

    if (slotType === 'bass') {
        const timbre = source ? ` (${source})` : '';
        return `${density} bassline${timbre}`;
    }

    if (slotType === 'chords') {
        const timbre = source ? ` (${source})` : '';
        return `${density} chord progression${timbre}`;
    }

    if (slotType === 'melody') {
        const noteTokens = pickUniqueTokens(grid.tokens, 8);
        const role = describeRegister(noteTokens, 'melody line');
        const timbre = source ? ` (${source})` : '';
        return `${density} ${role}${timbre}`;
    }

    const timbre = source ? ` (${source})` : '';
    if (featured) return `${density} motif: ${featured}${timbre}`;
    return `${density} texture${timbre}`;
}
