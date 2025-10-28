import pdf2md from '@opendocsg/pdf2md';
import { logger } from '../logger.js';
import { statusTracker } from '../statusTracker.js';
import { formatError } from '../utils/errors.js';

const handlePdfConversion = async (req, res) => {
  try {
    if (!req.file) {
      const message = 'No file provided';
      statusTracker.recordPdfConversion({ statusCode: 400, error: message });
      return res.status(400).json({ error: message });
    }

    const markdown = await pdf2md(req.file.buffer, {});

    statusTracker.recordPdfConversion({ statusCode: 200 });
    res.json({ markdown });
  } catch (err) {
    const message = formatError(err);
    logger.error(`[convert] ${message}`);
    statusTracker.recordPdfConversion({ statusCode: 500, error: message });
    res.status(500).json({ error: message });
  }
};

export { handlePdfConversion };
