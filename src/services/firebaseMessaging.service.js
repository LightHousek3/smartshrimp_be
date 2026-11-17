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

const configured = () => Boolean(config.firebase?.projectId);
const send = (message) => client().sendEachForMulticast(message);

module.exports = { configured, send };
