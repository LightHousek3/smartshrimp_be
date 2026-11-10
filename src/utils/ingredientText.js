/** Preserve label text; commas inside locants, brackets or quoted names are not separators. */
const splitIngredientText = (text) => {
    const parts = [];
    let start = 0;
    const brackets = [];
    let quote = null;
    const closing = { '(': ')', '[': ']', '{': '}' };
    const digit = (index) => /[0-9０-９]/u.test(text[index] || '');
    const chemicalComma = (index) => {
        let left = index - 1;
        let right = index + 1;
        while (left >= 0 && /\s/u.test(text[left])) left--;
        while (right < text.length && /\s/u.test(text[right])) right++;
        if (digit(left) && digit(right)) return true;
        const leftEnd = left + 1;
        const rightStart = right;
        const token = /[a-zA-Z0-9０-９'′″]/u;
        while (left >= 0 && token.test(text[left])) left--;
        while (right < text.length && token.test(text[right])) right++;
        const locant = /^(?:[0-9０-９]+|[NOSP])['′″]*$/iu;
        return locant.test(text.slice(left + 1, leftEnd)) && locant.test(text.slice(rightStart, right));
    };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const newline = /[\r\n\u2028\u2029]/u.test(char);
        if (!newline) {
            if (quote !== null) {
                if (char === quote) quote = null;
                continue;
            }
            if (char === '"' || char === '“') {
                quote = char === '“' ? '”' : '"';
                continue;
            }
            if (closing[char]) brackets.push(closing[char]);
            else if (brackets.length && char === brackets[brackets.length - 1]) brackets.pop();
        }
        const comma = /[,，、]/u.test(char);
        if (newline || (!brackets.length && (char === ';' || char === '；' || (comma && !chemicalComma(index))))) {
            const part = text.slice(start, index).trim();
            if (part) parts.push(part);
            start = index + 1;
            if (newline) {
                brackets.length = 0;
                quote = null;
            }
        }
    }
    const last = text.slice(start).trim();
    if (last) parts.push(last);
    return parts;
};

module.exports = { splitIngredientText };
