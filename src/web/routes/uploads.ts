import { Request, Response } from 'express';
import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import multer from 'multer';
import type { RouteContext } from '../types.js';

// File upload configuration
const uploadDir = join(homedir(), '.spellbook', 'uploads');
if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${timestamp}-${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

export function registerUploadRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  // API: Upload a file
  app.post('/api/upload', upload.single('file'), (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const filePath = join(uploadDir, req.file.filename);

    res.status(201).json({
      success: true,
      path: filePath,
      filename: req.file.originalname,
      savedAs: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  });

  // API: List recent uploads
  app.get('/api/uploads', (_req: Request, res: Response) => {
    try {
      if (!existsSync(uploadDir)) {
        res.json({ uploads: [] });
        return;
      }

      const files = readdirSync(uploadDir)
        .map(filename => {
          const filePath = join(uploadDir, filename);
          const stat = statSync(filePath);
          return {
            filename,
            path: filePath,
            size: stat.size,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 50);

      res.json({ uploads: files, directory: uploadDir });
    } catch (err) {
      console.error('Failed to list uploads:', err);
      res.status(500).json({ error: 'Failed to list uploads' });
    }
  });

  // API: Delete an uploaded file
  app.delete('/api/uploads/:filename', (req: Request, res: Response) => {
    const filename = req.params.filename as string;

    if (!filename) {
      res.status(400).json({ error: 'Filename is required' });
      return;
    }

    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const filePath = join(uploadDir, filename);

    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    try {
      unlinkSync(filePath);
      res.json({ success: true, deleted: filename });
    } catch (err) {
      console.error('Failed to delete file:', err);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });
}
