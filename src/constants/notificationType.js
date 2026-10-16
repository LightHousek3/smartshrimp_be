/**
 * Notification types matching the PostgreSQL notification_type enum.
 * Shared by notification producers, exact-type query validation, and service
 * category/group filters. Keep these values aligned with Prisma NotificationType.
 * A type identifies the event; referenceType/referenceId identify related data.
 */
module.exports = {
    // General system messages and account lifecycle events.
    SYSTEM: 'SYSTEM',
    // A managed account has completed activation.
    MANAGED_ACCOUNT_ACTIVATED: 'MANAGED_ACCOUNT_ACTIVATED',
    // An account's status has changed.
    ACCOUNT_STATUS_CHANGED: 'ACCOUNT_STATUS_CHANGED',
    // A technician or expert has been assigned to a season.
    SEASON_ASSIGNMENT_CREATED: 'SEASON_ASSIGNMENT_CREATED',
    // A season assignment has been replaced.
    SEASON_ASSIGNMENT_REPLACED: 'SEASON_ASSIGNMENT_REPLACED',
    // A season has moved to another status.
    SEASON_STATUS_CHANGED: 'SEASON_STATUS_CHANGED',
    // A scheduled operation is due for execution.
    OPERATION_DUE: 'OPERATION_DUE',
    // A scheduled operation has passed its due time.
    OPERATION_OVERDUE: 'OPERATION_OVERDUE',
    // A scheduled operation has been cancelled.
    OPERATION_CANCELLED: 'OPERATION_CANCELLED',
    // Automatic schedule generation has failed; included in the warning category.
    SCHEDULE_GENERATION_FAILED: 'SCHEDULE_GENERATION_FAILED',
    // A water measurement has exceeded a threshold; included in the warning category.
    WATER_THRESHOLD_EXCEEDED: 'WATER_THRESHOLD_EXCEEDED',
    // A task has been assigned to a recipient.
    TASK_ASSIGNED: 'TASK_ASSIGNED',
    // A task's details have changed.
    TASK_UPDATED: 'TASK_UPDATED',
    // A task is approaching its due time.
    TASK_DUE_SOON: 'TASK_DUE_SOON',
    // A task has passed its due time.
    TASK_OVERDUE: 'TASK_OVERDUE',
    // A task has been completed.
    TASK_COMPLETED: 'TASK_COMPLETED',
    // A disease case has been opened for review.
    DISEASE_CASE_CREATED: 'DISEASE_CASE_CREATED',
    // A disease case has received a response.
    DISEASE_CASE_RESPONSE: 'DISEASE_CASE_RESPONSE',
    // A disease case requires additional information.
    DISEASE_CASE_WAITING_INFO: 'DISEASE_CASE_WAITING_INFO',
    // A disease case is being monitored.
    DISEASE_CASE_MONITORING: 'DISEASE_CASE_MONITORING',
    // A disease case has been resolved.
    DISEASE_CASE_RESOLVED: 'DISEASE_CASE_RESOLVED',
    // A production protocol is awaiting review.
    PRODUCTION_PROTOCOL_PENDING: 'PRODUCTION_PROTOCOL_PENDING',
    // A production protocol has been reviewed.
    PRODUCTION_PROTOCOL_REVIEWED: 'PRODUCTION_PROTOCOL_REVIEWED',
    // A treatment protocol is awaiting review.
    TREATMENT_PROTOCOL_PENDING: 'TREATMENT_PROTOCOL_PENDING',
    // A treatment protocol has been reviewed.
    TREATMENT_PROTOCOL_REVIEWED: 'TREATMENT_PROTOCOL_REVIEWED',
    // A treatment protocol has been aborted.
    TREATMENT_PROTOCOL_ABORTED: 'TREATMENT_PROTOCOL_ABORTED',
    // An emergency disease case has an update; included in the disease group.
    EMERGENCY_CASE_UPDATE: 'EMERGENCY_CASE_UPDATE',
    // A treatment schedule is ready for execution.
    TREATMENT_SCHEDULE_READY: 'TREATMENT_SCHEDULE_READY',
    // A treatment schedule has been completed.
    TREATMENT_SCHEDULE_COMPLETED: 'TREATMENT_SCHEDULE_COMPLETED',
    // Inventory is below its minimum level; included in the warning category.
    INVENTORY_LOW: 'INVENTORY_LOW',
    // Inventory cannot satisfy a requirement; included in the warning category.
    INVENTORY_INSUFFICIENT: 'INVENTORY_INSUFFICIENT',
    // A season is due for harvest.
    HARVEST_DUE: 'HARVEST_DUE',
    // A season has been completed.
    SEASON_COMPLETED: 'SEASON_COMPLETED',
};
