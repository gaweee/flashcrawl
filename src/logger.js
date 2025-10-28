import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { config } from './config.js';

if (!fs.existsSync(config.logDir)) {
  fs.mkdirSync(config.logDir, { recursive: true });
}

const currentDate = new Date().toISOString().split('T')[0];

const fileLogFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`),
);

const transports = [
  new winston.transports.File({
    filename: path.join(config.logDir, `flashcrawl-${currentDate}.log`),
    level: 'info',
  }),
  new winston.transports.File({
    filename: path.join(config.logDir, `flashcrawl-error-${currentDate}.log`),
    level: 'error',
  }),
];

if (config.enableConsoleLog) {
  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`),
      ),
    }),
  );
}

const logger = winston.createLogger({
  level: 'info',
  format: fileLogFormat,
  transports,
});

export { logger };
