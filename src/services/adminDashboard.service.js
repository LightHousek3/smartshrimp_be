const axios = require('axios');
const config = require('../config');
const prisma = require('../config/prisma');
const { ACCOUNT_STATUS } = require('../constants');

const HEALTH_CHECK_TIMEOUT_MS = 2000;

/**
 * Format a Date object to YYYY-MM-DD in Vietnam timezone
 * @param {Date} date
 * @returns {string}
 */
const formatVietnamDate = (date) => {
    return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
};

/**
 * Get system overview metrics, 7-day AI metrics, 7-day RAG metrics, and account status breakdown
 * @returns {Promise<Object>}
 */
const getSystemOverview = async () => {
    const [overviewRows] = await prisma.$queryRaw`SELECT * FROM v_admin_system_overview LIMIT 1`;

    const accountsGroup = await prisma.account.groupBy({
        by: ['status'],
        _count: { _all: true },
    });

    const statusCounts = {
        [ACCOUNT_STATUS.ACTIVE]: 0,
        [ACCOUNT_STATUS.PENDING_ACTIVATION]: 0,
        [ACCOUNT_STATUS.INACTIVE]: 0,
        [ACCOUNT_STATUS.BLOCKED]: 0,
    };

    for (const item of accountsGroup) {
        if (statusCounts[item.status] !== undefined) {
            statusCounts[item.status] = item._count._all;
        }
    }

    // Build continuous 7-day window
    const now = new Date();
    const dates = [];
    for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now.getTime() - i * 86400000);
        const dateStr = formatVietnamDate(d);
        const label = `${dateStr.slice(8, 10)}/${dateStr.slice(5, 7)}`;
        dates.push({ dateStr, label });
    }

    const startDateStr = dates[0].dateStr;

    const [aiRows, ragRows] = await Promise.all([
        prisma.$queryRaw`
            SELECT * FROM v_ai_daily_analytics
            WHERE metric_date >= ${startDateStr}::date
            ORDER BY metric_date ASC
        `,
        prisma.$queryRaw`
            SELECT * FROM v_rag_daily_analytics
            WHERE metric_date >= ${startDateStr}::date
            ORDER BY metric_date ASC
        `,
    ]);

    const aiMap = new Map();
    for (const row of aiRows) {
        const dStr = formatVietnamDate(new Date(row.metric_date));
        aiMap.set(dStr, row);
    }

    const ragMap = new Map();
    for (const row of ragRows) {
        const dStr = formatVietnamDate(new Date(row.metric_date));
        ragMap.set(dStr, row);
    }

    const aiDailyMetrics = dates.map(({ dateStr, label }) => {
        const row = aiMap.get(dateStr);
        if (row) {
            return {
                date: label,
                fullDate: dateStr,
                total: Number(row.total_predictions || 0),
                success: Number(row.successful_predictions || 0),
                errors: Number(row.technical_errors || 0),
                avgConfidence: row.avg_confidence != null ? Number(row.avg_confidence) : 0,
                avgProcessingMs: Math.round(Number(row.avg_processing_time_ms || 0)),
            };
        }
        return {
            date: label,
            fullDate: dateStr,
            total: 0,
            success: 0,
            errors: 0,
            avgConfidence: 0,
            avgProcessingMs: 0,
        };
    });

    const ragDailyMetrics = dates.map(({ dateStr, label }) => {
        const row = ragMap.get(dateStr);
        if (row) {
            return {
                date: label,
                fullDate: dateStr,
                total: Number(row.total_questions || 0),
                answered: Number(row.answered_questions || 0),
                noSource: Number(row.no_source_questions || 0),
                lowMatch: Number(row.low_match_questions || 0),
                avgRating: row.avg_star_rating != null ? Number(row.avg_star_rating) : 0,
            };
        }
        return {
            date: label,
            fullDate: dateStr,
            total: 0,
            answered: 0,
            noSource: 0,
            lowMatch: 0,
            avgRating: 0,
        };
    });

    const totalAccounts = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    const systemOverview = {
        totalAccounts,
        managedAccounts: Number(overviewRows?.managed_accounts || 0),
        activeAccounts: statusCounts[ACCOUNT_STATUS.ACTIVE] !== undefined
            ? statusCounts[ACCOUNT_STATUS.ACTIVE]
            : Number(overviewRows?.active_accounts || 0),
        pendingActivation: statusCounts[ACCOUNT_STATUS.PENDING_ACTIVATION] !== undefined
            ? statusCounts[ACCOUNT_STATUS.PENDING_ACTIVATION]
            : Number(overviewRows?.pending_activation_accounts || 0),
        blockedAccounts: statusCounts[ACCOUNT_STATUS.BLOCKED] || 0,
        inactiveAccounts: statusCounts[ACCOUNT_STATUS.INACTIVE] || 0,
        activeFarms: Number(overviewRows?.active_farms || 0),
        activeSeasons: Number(overviewRows?.active_seasons || 0),
        aiRequestsToday: Number(overviewRows?.ai_requests_today || 0),
        ragQuestionsToday: Number(overviewRows?.rag_questions_today || 0),
    };

    const accountStatusBreakdown = [
        {
            label: 'Hoạt động',
            status: ACCOUNT_STATUS.ACTIVE,
            count: statusCounts[ACCOUNT_STATUS.ACTIVE] || 0,
            color: '#0f9b8e',
            bg: '#e2f6f3',
        },
        {
            label: 'Chờ kích hoạt',
            status: ACCOUNT_STATUS.PENDING_ACTIVATION,
            count: statusCounts[ACCOUNT_STATUS.PENDING_ACTIVATION] || 0,
            color: '#d98314',
            bg: '#fbf0dc',
        },
        {
            label: 'Không hoạt động',
            status: ACCOUNT_STATUS.INACTIVE,
            count: statusCounts[ACCOUNT_STATUS.INACTIVE] || 0,
            color: '#64748b',
            bg: '#eef1f6',
        },
        {
            label: 'Đã khóa',
            status: ACCOUNT_STATUS.BLOCKED,
            count: statusCounts[ACCOUNT_STATUS.BLOCKED] || 0,
            color: '#d43b57',
            bg: '#fbe6ea',
        },
    ];

    return {
        systemOverview,
        aiDailyMetrics,
        ragDailyMetrics,
        accountStatusBreakdown,
    };
};

/**
 * Probe an internal AI service health endpoint with a short timeout so admin checks never stall.
 */
const probeServiceHealth = async ({ key, name, baseUrl, versionField }) => {
    const normalizedUrl = (baseUrl || '').replace(/\/+$/, '');
    if (!normalizedUrl) {
        return {
            key,
            name,
            status: 'NOT_CONFIGURED',
            configured: false,
            latencyMs: null,
            version: null,
        };
    }

    const startedAt = Date.now();
    try {
        const { data } = await axios.get(`${normalizedUrl}/v1/health`, {
            timeout: HEALTH_CHECK_TIMEOUT_MS,
            maxRedirects: 0,
        });
        const latencyMs = Math.max(0, Date.now() - startedAt);
        const healthy = data?.status === 'ok';
        return {
            key,
            name,
            status: healthy ? 'UP' : 'DOWN',
            configured: true,
            latencyMs,
            version: healthy && typeof data?.[versionField] === 'string' ? data[versionField] : null,
        };
    } catch {
        return {
            key,
            name,
            status: 'DOWN',
            configured: true,
            latencyMs: Math.max(0, Date.now() - startedAt),
            version: null,
        };
    }
};

/**
 * Check live health status for AI disease classification and RAG services in parallel.
 */
const getServicesHealth = async () => {
    const services = await Promise.all([
        probeServiceHealth({
            key: 'ai_diagnosis',
            name: 'AI Chẩn đoán bệnh trên tôm',
            baseUrl: config.ai?.serviceUrl,
            versionField: 'model_version',
        }),
        probeServiceHealth({
            key: 'rag',
            name: 'Trợ lý AquaBot',
            baseUrl: config.rag?.serviceUrl,
            versionField: 'version',
        }),
    ]);

    return {
        checkedAt: new Date().toISOString(),
        services,
    };
};

module.exports = {
    getSystemOverview,
    getServicesHealth,
};
