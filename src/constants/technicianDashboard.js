/** Only task and season previews are bounded; alerts and today's operations are complete. */
const TECHNICIAN_DASHBOARD_LIMITS = Object.freeze({ tasks: 3, seasons: 3 });
const TECHNICIAN_ALERT_KIND = Object.freeze({
    WATER: 'WATER', OVERDUE_OPERATIONS: 'OVERDUE_OPERATIONS', SCHEDULE_BLOCKED: 'SCHEDULE_BLOCKED',
});

module.exports = { TECHNICIAN_DASHBOARD_LIMITS, TECHNICIAN_ALERT_KIND };
