const { applicationDefault, getApps, initializeApp } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const config = require('../config');

/** ADC keeps service credentials outside source control and mobile application bundles. */
const client = () => {
    const app =
        getApps().find((row) => row.name === 'smartshrimp-push') ??
        initializeApp(
            { credential: applicationDefault(), projectId: config.firebase.projectId },
            'smartshrimp-push',
        );
    return getMessaging(app);
};

/**
 * Check whether a Firebase project is configured before starting push delivery.
 */
const configured = () => Boolean(config.firebase?.projectId);
/**
 * Send a multicast batch and return Firebase's per-device results for delivery tracking.
 */
const send = (message) => client().sendEachForMulticast(message);

module.exports = { configured, send };
