const { PROHIBITED_INGREDIENTS } = require('../constants/prohibitedAquacultureIngredients');
const {
    INGREDIENT_CATALOG_SOURCE,
    INVENTORY_INGREDIENT_SUGGESTIONS,
} = require('../constants/inventoryIngredientSuggestions');
const ApiError = require('./ApiError');
const { MATERIAL_COMPLIANCE } = require('../constants/messages');
const { splitIngredientText } = require('./ingredientText');

const SEARCH_PAGE_SIZE = 5;

const normalize = (text) => String(text || '').normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[đĐ]/gu, 'd').toLowerCase().replace(/([a-z])(\d)/gu, '$1 $2').replace(/[^a-z0-9]+/gu, ' ').trim();
const publicEntry = (entry) => ({ id: entry.id, name: entry.name, status: entry.status,
    group: entry.group, appendix: entry.appendix, sourceRow: entry.sourceRow,
    page: entry.page, note: entry.sourceText });
const source = Object.freeze({ document: INGREDIENT_CATALOG_SOURCE.document,
    version: INGREDIENT_CATALOG_SOURCE.version, url: INGREDIENT_CATALOG_SOURCE.url });
const entries = [...PROHIBITED_INGREDIENTS, ...INVENTORY_INGREDIENT_SUGGESTIONS].map((entry) => ({
    ...entry,
    searchText: normalize([entry.name, entry.group, ...entry.aliases].join(' ')),
}));
// A separately named substance owns its aliases, even when it also belongs to a banned group.
const individualAliases = new Set(PROHIBITED_INGREDIENTS.filter((entry) => !entry.isGroup)
    .flatMap((entry) => entry.aliases.map(normalize)));
const banned = entries.filter((entry) => entry.status === 'banned').map((entry) => ({
    ...entry,
    patterns: [...new Map(entry.aliases
        .filter((name) => !entry.isGroup || !individualAliases.has(normalize(name)))
        .map((name) => [normalize(name), name])).entries()].filter(([alias]) => alias)
        .map(([alias, name]) => ({ name, alias,
            pattern: new RegExp(`(?:^| )(${alias.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})(?= |$)`, 'gu') })),
}));

/** A bounded catalog search, never a legal approval of the complete product. */
const searchSubstances = ({ q = '', cursor = '0' } = {}) => {
    const query = normalize(q);
    const filtered = entries.filter((entry) => !query || entry.searchText.includes(query))
        .sort((a, b) => {
            const rank = (entry) => normalize(entry.name).startsWith(query) ? 0 : 1;
            return rank(a) - rank(b) || a.name.localeCompare(b.name, 'vi') || a.id.localeCompare(b.id);
        });
    const offset = Number(cursor);
    const nextOffset = offset + SEARCH_PAGE_SIZE;
    const data = filtered.slice(offset, nextOffset).map(publicEntry);
    return {
        data,
        meta: {
            limit: SEARCH_PAGE_SIZE,
            totalResults: filtered.length,
            hasNextPage: nextOffset < filtered.length,
            nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
            source,
        },
    };
};

/** Match complete names/explicit source aliases, retaining negated mentions for manual review. */
const checkIngredients = (text = '') => {
    const clauses = splitIngredientText(String(text || '')).map((raw) => ({ raw, normalized: normalize(raw) }));
    const hits = [];
    for (const entry of banned) {
        for (const [clauseIndex, clause] of clauses.entries()) {
            for (const { name, alias, pattern } of entry.patterns) {
                pattern.lastIndex = 0;
                for (const match of clause.normalized.matchAll(pattern)) {
                    // DES is an acronym in the PDF, not the ordinary lower-case word "des".
                    if (alias === 'des' && !/\bDES\b/u.test(clause.raw)) continue;
                    const before = clause.normalized.slice(Math.max(0, match.index - 65), match.index).trim();
                    const after = clause.normalized.slice(match.index + match[0].length, match.index + match[0].length + 45).trim();
                    const negated = /(?:khong(?: co| chua| phat hien)?|without|free of|no)\s*$/u.test(before)
                        || /^(?:khong(?: co| phat hien)?|not detected|absent)(?: |$)/u.test(after);
                    const start = match.index + match[0].length - match[1].length;
                    hits.push({ entryId: entry.id, name, clauseIndex, start, end: start + match[1].length,
                        mention: negated ? 'negated' : 'present' });
                }
            }
        }
    }
    // Prefer the full matched alias over shorter aliases within the same occurrence.
    let lastClause = -1;
    let coveredEnd = -1;
    const detected = hits.sort((a, b) => a.clauseIndex - b.clauseIndex || a.start - b.start || b.end - a.end)
        .filter((hit) => {
            if (hit.clauseIndex !== lastClause) {
                lastClause = hit.clauseIndex;
                coveredEnd = -1;
            }
            if (hit.end <= coveredEnd) return false;
            coveredEnd = hit.end;
            return true;
        });
    const matches = banned.flatMap((entry) => {
        const mentions = detected.filter((hit) => hit.entryId === entry.id);
        return mentions.length ? [{ ...publicEntry(entry),
            mention: mentions.some((hit) => hit.mention === 'present') ? 'present' : 'negated' }] : [];
    });
    const status = matches.some((match) => match.mention === 'present') ? 'blocked' : matches.length ? 'needs_review' : 'not_detected';
    const names = (mention) => [...new Map(detected.filter((hit) => hit.mention === mention)
        .map((hit) => [normalize(hit.name), hit.name])).values()];
    const present = names('present');
    const negated = names('negated').filter((name) => !present.some((item) => normalize(item) === normalize(name)));
    let message = status === 'blocked'
        ? MATERIAL_COMPLIANCE.DETECTED_SUBSTANCES(present.join(', '))
        : status === 'needs_review'
            ? MATERIAL_COMPLIANCE.PROHIBITED_REVIEW_REQUIRED
            : MATERIAL_COMPLIANCE.NO_PROHIBITED_MATCH;
    if (negated.length) message += ` ${MATERIAL_COMPLIANCE.NEGATED_SUBSTANCES(negated.join(', '))}`;
    return { status, matches, message, source };
};

const requireUsableIngredients = (text) => {
    const check = checkIngredients(text);
    if (check.status !== 'not_detected') throw ApiError.forbidden(check.message);
};

module.exports = { searchSubstances, checkIngredients, requireUsableIngredients };
