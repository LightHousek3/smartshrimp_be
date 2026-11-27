const { isWeightSample, populationMatches } = require('../utils/biomassSource');
const notices = require('../utils/jobNotification');

/** Remind against the source episode, not every slot or every daily comment. */
const remind = async (tx, protocol, logs, firstMissingAt, harvestedAt, now) => {
    if (!firstMissingAt) return [];
    const measured = logs.find(isWeightSample);
    const population = logs.find((row) => row.estimatedPopulation != null);
    const voided = await tx.shrimpHealthLog.findFirst({
        where: {
            seasonId: protocol.seasonId,
            isVoided: true,
            sampleSize: { gt: 0 },
            avgWeightG: { gt: 0 },
            voidedAt: { lte: now },
        },
        orderBy: [{ voidedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, recordedAt: true, voidedAt: true },
    });
    const changedPopulation =
        measured &&
        !populationMatches({
            ...measured,
            populationId: population?.id,
            populationAt: population?.recordedAt,
            latestPopulation: population?.estimatedPopulation,
        });
    const invalidated =
        changedPopulation ||
        (harvestedAt && (!measured || measured.recordedAt <= harvestedAt)) ||
        (voided && (!measured || measured.recordedAt <= voided.recordedAt));
    if (!invalidated && firstMissingAt - now > 24 * 3600000) return [];
    const personnel = await tx.seasonPersonnelAssignment.findMany({
        where: {
            seasonId: protocol.seasonId,
            role: 'TECHNICIAN',
            unassignedAt: null,
            account: {
                role: 'TECHNICIAN',
                status: 'ACTIVE',
                managedByOwnerId: protocol.season.pond.farm.ownerId,
            },
        },
        select: { accountId: true },
    });
    const saved = [];
    for (const { accountId } of personnel) {
        const notification = await notices.save(
            tx,
            [
                'biomass-sampling',
                protocol.id,
                measured?.id ?? null,
                measured?.estimatedBiomassKg?.toString() ?? null,
                population?.estimatedPopulation?.toString() ?? null,
                harvestedAt?.toISOString() ?? null,
                voided?.id ?? null,
            ],
            {
                accountId,
                type: 'SYSTEM',
                referenceType: 'biomass_sampling',
                referenceId: protocol.seasonId,
                title: invalidated
                    ? 'Cần cập nhật sinh khối sau biến động đàn'
                    : 'Cần chuẩn bị mẫu sinh khối cho cữ sắp tới',
                content:
                    `${protocol.title}: cữ lúc ${firstMissingAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} chưa có nguồn sinh khối hợp lệ. ` +
                    'Hãy lấy mẫu đại diện, cân đo và cập nhật nhật ký sức khỏe. Nguồn tối đa 7 ngày tại cữ và phải còn đại diện; nhận xét hằng ngày không làm mới số cân.',
                createdAt: now,
            },
        );
        if (notification) saved.push(notification);
    }
    return saved;
};

module.exports = { remind };
