function normalizeDateString(input) {
    if (!input) return "N/A";
    const raw = `${input}`.trim();
    if (!raw) return "N/A";
    return raw;
}

module.exports = { normalizeDateString };
