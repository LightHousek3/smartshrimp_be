const { PrismaClient } = require('@prisma/client');
const { database } = require('./index');

const url = new URL(database.url);

// Session pooler connections are shared across all running backend instances.
if (
    url.hostname.endsWith('.pooler.supabase.com')
    && (url.port || '5432') === '5432'
    && !url.searchParams.has('connection_limit')
) {
    url.searchParams.set('connection_limit', '5');
}

const prisma = new PrismaClient({ datasourceUrl: url.toString() });

module.exports = prisma;
