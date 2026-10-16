// Day bounds are inclusive. Compare every pair without changing display order.
const hasOverlappingStages = (stages) => stages.some((stage, index) => (
    stages.slice(index + 1).some((other) => (
        stage.startDayOffset <= other.endDayOffset && other.startDayOffset <= stage.endDayOffset
    ))
));

module.exports = { hasOverlappingStages };
