import express from 'express';
import multer from 'multer';
import { handleCrawl } from './services/crawlService.js';
import { handlePdfConversion } from './services/pdfService.js';
import { statusTracker } from './statusTracker.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.get('/status', (_req, res) => {
  res.json(statusTracker.getSnapshot());
});

app.post('/convert', upload.single('file'), handlePdfConversion);
app.get('/crawl', handleCrawl);

export { app };
