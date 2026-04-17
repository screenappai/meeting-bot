import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

const tempFolder = path.join(process.cwd(), 'dist', '_tempvideo');

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function isValidSegment(segment: string): boolean {
  return segment !== '..' && !segment.includes('/') && !segment.includes('\\') && segment !== '';
}

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; font-weight: 600; }
  .back { display: inline-block; margin-bottom: 1rem; color: #0066cc; text-decoration: none; font-size: 0.9rem; }
  .back:hover { text-decoration: underline; }
  .section { margin-bottom: 2rem; }
  .section h2 { font-size: 1.1rem; margin-bottom: 0.75rem; color: #555; font-weight: 500; }
  ul { list-style: none; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  li { border-bottom: 1px solid #eee; }
  li:last-child { border-bottom: none; }
  a { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem; text-decoration: none; color: #333; transition: background 0.15s; }
  a:hover { background: #f0f6ff; }
  .meta { font-size: 0.8rem; color: #888; }
  .empty { color: #999; font-style: italic; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(tempFolder)) {
      res.status(200).send(htmlPage('Recordings', '<h1>Recordings</h1><p class="empty">No recordings found.</p>'));
      return;
    }

    const entries = await fs.promises.readdir(tempFolder, { withFileTypes: true });
    const userDirs = entries.filter(e => e.isDirectory());
    const rootFiles = entries.filter(e => e.isFile());

    let body = '<h1>Recordings</h1>';

    if (userDirs.length > 0) {
      body += '<div class="section"><h2>User Folders</h2><ul>';
      for (const dir of userDirs.sort((a, b) => a.name.localeCompare(b.name))) {
        body += `<li><a href="/recordings/${encodeURIComponent(dir.name)}"><span>${escapeHtml(dir.name)}</span><span class="meta">folder</span></a></li>`;
      }
      body += '</ul></div>';
    }

    if (rootFiles.length > 0) {
      body += '<div class="section"><h2>Other Recordings</h2><ul>';
      for (const file of rootFiles.sort((a, b) => a.name.localeCompare(b.name))) {
        const filePath = path.join(tempFolder, file.name);
        const stats = await fs.promises.stat(filePath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        const modified = stats.mtime.toLocaleString();
        body += `<li><a href="/recordings/_root/${encodeURIComponent(file.name)}"><span>${escapeHtml(file.name)}</span><span class="meta">${sizeMB} MB &middot; ${modified}</span></a></li>`;
      }
      body += '</ul></div>';
    }

    if (userDirs.length === 0 && rootFiles.length === 0) {
      body += '<p class="empty">No recordings found.</p>';
    }

    res.status(200).send(htmlPage('Recordings', body));
  } catch (err) {
    res.status(500).send(htmlPage('Error', '<h1>Error</h1><p>Failed to read recordings directory.</p>'));
  }
});

router.get('/_root/:filename', async (req: Request, res: Response) => {
  const { filename } = req.params;

  if (!isValidSegment(filename)) {
    res.status(400).json({ error: 'Invalid filename.' });
    return;
  }

  try {
    const filePath = path.join(tempFolder, filename);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).send(htmlPage('Not Found', '<h1>Not Found</h1><p>File not found.</p>'));
      return;
    }

    res.download(filePath, filename);
  } catch (err) {
    res.status(500).json({ error: 'Failed to serve file.' });
  }
});

router.get('/:userId', async (req: Request, res: Response) => {
  const { userId } = req.params;

  if (!isValidSegment(userId)) {
    res.status(400).send(htmlPage('Error', '<h1>Error</h1><p>Invalid user ID.</p>'));
    return;
  }

  try {
    const userPath = path.join(tempFolder, userId);

    if (!fs.existsSync(userPath) || !fs.statSync(userPath).isDirectory()) {
      res.status(404).send(htmlPage('Not Found', '<h1>Not Found</h1><p>User folder not found.</p>'));
      return;
    }

    const files = await fs.promises.readdir(userPath, { withFileTypes: true });
    const fileEntries = files.filter(e => e.isFile());

    let body = `<h1>Recordings &mdash; ${escapeHtml(userId)}</h1>`;
    body += '<a href="/recordings" class="back">&larr; Back to all recordings</a>';

    if (fileEntries.length > 0) {
      body += '<ul style="margin-top:1rem">';
      for (const file of fileEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        const filePath = path.join(userPath, file.name);
        const stats = await fs.promises.stat(filePath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        const modified = stats.mtime.toLocaleString();
        body += `<li><a href="/recordings/${encodeURIComponent(userId)}/${encodeURIComponent(file.name)}"><span>${escapeHtml(file.name)}</span><span class="meta">${sizeMB} MB &middot; ${modified}</span></a></li>`;
      }
      body += '</ul>';
    } else {
      body += '<p class="empty" style="margin-top:1rem">No recordings found for this user.</p>';
    }

    res.status(200).send(htmlPage(`Recordings — ${escapeHtml(userId)}`, body));
  } catch (err) {
    res.status(500).send(htmlPage('Error', '<h1>Error</h1><p>Failed to read recordings.</p>'));
  }
});

router.get('/:userId/:filename', async (req: Request, res: Response) => {
  const { userId, filename } = req.params;

  if (!isValidSegment(userId) || !isValidSegment(filename)) {
    res.status(400).json({ error: 'Invalid path parameters.' });
    return;
  }

  try {
    const filePath = path.join(tempFolder, userId, filename);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).send(htmlPage('Not Found', '<h1>Not Found</h1><p>File not found.</p>'));
      return;
    }

    res.download(filePath, filename);
  } catch (err) {
    res.status(500).json({ error: 'Failed to serve file.' });
  }
});

export default router;
