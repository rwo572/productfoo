import express from 'express';
import { q } from './db.js';
const app = express();
app.get('/api/documents', async (req, res) => {
  const { rows } = await q('SELECT * FROM documents WHERE team_id = $1', [req.teamId]);
  res.json(rows);
});
app.listen(3000);
