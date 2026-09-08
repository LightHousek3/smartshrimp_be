const winston = require('winston');
const path = require('path');

const config = require('./index');

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
        return `${timestamp} [${level.toUpperCase()}]: ${stack || message}`;
    })
);

const transports = [
    new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            logFormat
        ),
    }),
];

// File transports only in non-test environments
if (config.env !== 'test') {
    transports.push(
        new winston.transports.File({
            filename: path.join(config.log.dir, 'error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5,
        }),
        new winston.transports.File({
            filename: path.join(config.log.dir, 'combined.log'),
            maxsize: 5242880,
            maxFiles: 5,
        })
    );
}

const logger = winston.createLogger({
    level: config.log.level,
    format: logFormat,
    transports,
    exitOnError: false,
});

module.exports = logger;
