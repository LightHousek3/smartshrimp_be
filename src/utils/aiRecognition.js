const {
    AI_MIN_RECOGNITION_CONFIDENCE,
    AI_RECOGNITION_STATUS,
    AI_LABEL_NAMES,
} = require('../constants/aiDiagnosis');

/** Apply the public recognition policy to a saved successful inference. */
const recognitionResult = (row) => {
    // SQL rounds confidence; use the original JSON probability at the cutoff.
    const confidence = row.predictions[0].probability;
    const recognized = confidence >= AI_MIN_RECOGNITION_CONFIDENCE;
    return {
        recognitionStatus: recognized ? AI_RECOGNITION_STATUS.RECOGNIZED : AI_RECOGNITION_STATUS.UNRECOGNIZED,
        predictedLabel: recognized ? AI_LABEL_NAMES[row.predictedLabel] : null,
        confidence,
    };
};

module.exports = recognitionResult;
