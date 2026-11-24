/**
 * Reject invalid pagination inputs before sending skip or take values to Prisma.
 */
const assertPositiveInteger = (value, name) => {
    if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
    }
};

/**
 * Count and page the same filter so response metadata describes the full result set.
 */
const paginateOffset = async ({ delegate, where = {}, page, limit, ...findManyArgs }) => {
    assertPositiveInteger(page, 'page');
    assertPositiveInteger(limit, 'limit');

    const [items, totalResults] = await Promise.all([
        delegate.findMany({
            ...findManyArgs,
            where,
            skip: (page - 1) * limit,
            take: limit,
        }),
        delegate.count({ where }),
    ]);
    const totalPages = Math.ceil(totalResults / limit);

    return {
        items,
        meta: {
            page,
            limit,
            totalResults,
            totalPages,
            hasNextPage: page < totalPages,
        },
    };
};

/**
 * Read one extra row to detect a next page and count all rows matching the original filter.
 */
const paginateCursor = async ({
    delegate,
    where = {},
    cursor,
    limit,
    cursorField = 'id',
    ...findManyArgs
}) => {
    assertPositiveInteger(limit, 'limit');

    const [rows, totalResults] = await Promise.all([
        delegate.findMany({
            ...findManyArgs,
            where,
            take: limit + 1,
            ...(cursor && {
                cursor: { [cursorField]: cursor },
                skip: 1,
            }),
        }),
        delegate.count({ where }),
    ]);
    const hasNextPage = rows.length > limit;
    const items = hasNextPage ? rows.slice(0, limit) : rows;

    return {
        items,
        meta: {
            limit,
            totalResults,
            hasNextPage,
            nextCursor: hasNextPage ? items[items.length - 1][cursorField] : null,
        },
    };
};

module.exports = {
    paginateCursor,
    paginateOffset,
};
