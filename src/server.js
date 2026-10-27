'use strict';
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const XLSX = require('xlsx');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not configured');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not configured');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use('/api/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));
app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'development-only-change-me-before-deploying',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'xlsx', 'dist'), { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS app_users (
    id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stock_groups (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,name)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS chats (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    group_id BIGINT REFERENCES stock_groups(id) ON DELETE SET NULL, title TEXT NOT NULL DEFAULT 'New chat',
    messages JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reconciliations (
    id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    chat_id BIGINT REFERENCES chats(id) ON DELETE SET NULL, group_id BIGINT REFERENCES stock_groups(id) ON DELETE SET NULL,
    title TEXT NOT NULL, stock_date DATE, data1_name TEXT NOT NULL DEFAULT 'Actual Quantity', data2_name TEXT NOT NULL DEFAULT 'Physical Stock',
    actual_rows JSONB NOT NULL DEFAULT '[]'::jsonb, physical_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
    results JSONB NOT NULL DEFAULT '[]'::jsonb, summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS chats_user_updated_idx ON chats(user_id, updated_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS rec_user_created_idx ON reconciliations(user_id, created_at DESC)`);
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
    const existing = await pool.query('SELECT id FROM app_users WHERE email=$1', [email]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await pool.query('INSERT INTO app_users(email,password_hash) VALUES($1,$2)', [email, hash]);
      console.log(`Initial owner account created for ${email}`);
    }
  }
}
function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in again.' });
  next();
}
function id(v) { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; }
async function ownedRow(table, rowId, userId) {
  const allowed = { chats: 'chats', groups: 'stock_groups', reconciliations: 'reconciliations' };
  if (!allowed[table]) return null;
  const q = await pool.query(`SELECT * FROM ${allowed[table]} WHERE id=$1 AND user_id=$2`, [rowId, userId]);
  return q.rows[0] || null;
}
function safeError(res, err) {
  console.error(err && err.message ? err.message : err);
  return res.status(500).json({ error: 'A server error occurred. Please retry. Your saved data has not intentionally been deleted.' });
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected' }); }
  catch (_) { res.status(503).json({ ok: false, database: 'temporarily unavailable' }); }
});
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ signedIn: false });
  try {
    const q = await pool.query('SELECT id,email,created_at FROM app_users WHERE id=$1', [req.session.userId]);
    if (!q.rowCount) { req.session.destroy(()=>{}); return res.json({ signedIn: false }); }
    res.json({ signedIn: true, user: q.rows[0] });
  } catch (e) { safeError(res,e); }
});
app.post('/api/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Enter email and password.' });
    const q = await pool.query('SELECT id,email,password_hash FROM app_users WHERE email=$1', [email]);
    if (!q.rowCount || !(await bcrypt.compare(password, q.rows[0].password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
    req.session.regenerate(err => {
      if (err) return safeError(res,err);
      req.session.userId = String(q.rows[0].id);
      req.session.email = q.rows[0].email;
      req.session.save(err2 => err2 ? safeError(res,err2) : res.json({ ok: true, email: q.rows[0].email }));
    });
  } catch(e) { safeError(res,e); }
});
app.post('/api/logout', (req,res) => req.session.destroy(err => { res.clearCookie('connect.sid'); if(err) return safeError(res,err); res.json({ok:true}); }));
app.get('/api/groups', auth, async (req,res) => {
  try { const q=await pool.query('SELECT id,name,created_at FROM stock_groups WHERE user_id=$1 ORDER BY name',[req.session.userId]); res.json(q.rows); } catch(e){safeError(res,e);}
});
app.post('/api/groups', auth, async (req,res) => {
  try { const name=String(req.body.name||'').trim(); if(!name||name.length>100) return res.status(400).json({error:'Enter a group name up to 100 characters.'});
    const q=await pool.query('INSERT INTO stock_groups(user_id,name) VALUES($1,$2) RETURNING *',[req.session.userId,name]); res.status(201).json(q.rows[0]);
  } catch(e){ if(e.code==='23505') return res.status(409).json({error:'A group with that name already exists.'}); safeError(res,e); }
});
app.patch('/api/groups/:id', auth, async (req,res) => {
  try { const gid=id(req.params.id), name=String(req.body.name||'').trim(); if(!gid||!name||name.length>100) return res.status(400).json({error:'Invalid group or name.'});
    const q=await pool.query('UPDATE stock_groups SET name=$1 WHERE id=$2 AND user_id=$3 RETURNING *',[name,gid,req.session.userId]); if(!q.rowCount)return res.status(404).json({error:'Group not found.'});res.json(q.rows[0]);
  } catch(e){ if(e.code==='23505') return res.status(409).json({error:'A group with that name already exists.'});safeError(res,e); }
});
app.delete('/api/groups/:id', auth, async (req,res) => {
  try { const gid=id(req.params.id); const q=await pool.query('DELETE FROM stock_groups WHERE id=$1 AND user_id=$2 RETURNING id',[gid,req.session.userId]); if(!q.rowCount)return res.status(404).json({error:'Group not found.'});res.json({ok:true}); } catch(e){safeError(res,e);}
});
app.get('/api/chats', auth, async (req,res) => {
  try { const q=await pool.query(`SELECT c.id,c.title,c.group_id,c.created_at,c.updated_at,g.name AS group_name FROM chats c LEFT JOIN stock_groups g ON g.id=c.group_id WHERE c.user_id=$1 ORDER BY c.updated_at DESC`,[req.session.userId]);res.json(q.rows); } catch(e){safeError(res,e);}
});
app.post('/api/chats', auth, async (req,res) => {
  try { let gid=id(req.body.groupId); if(gid && !(await ownedRow('groups',gid,req.session.userId)))return res.status(404).json({error:'Stock group not found.'});
    const title=String(req.body.title||'New chat').trim().slice(0,160)||'New chat'; const q=await pool.query('INSERT INTO chats(user_id,group_id,title) VALUES($1,$2,$3) RETURNING *',[req.session.userId,gid,title]);res.status(201).json(q.rows[0]);
  } catch(e){safeError(res,e);}
});
app.get('/api/chats/:id', auth, async (req,res) => {
  try { const cid=id(req.params.id), q=await pool.query(`SELECT c.*,g.name AS group_name FROM chats c LEFT JOIN stock_groups g ON g.id=c.group_id WHERE c.id=$1 AND c.user_id=$2`,[cid,req.session.userId]); if(!q.rowCount)return res.status(404).json({error:'Chat not found.'});
    const rec=await pool.query('SELECT * FROM reconciliations WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at DESC',[cid,req.session.userId]);res.json({chat:q.rows[0],reconciliations:rec.rows});
  } catch(e){safeError(res,e);}
});
app.patch('/api/chats/:id', auth, async (req,res) => {
  try { const cid=id(req.params.id); const existing=await ownedRow('chats',cid,req.session.userId);if(!existing)return res.status(404).json({error:'Chat not found.'});
    const title=req.body.title===undefined?existing.title:String(req.body.title).trim().slice(0,160)||'New chat';
    const messages=req.body.messages===undefined?existing.messages:req.body.messages;
    if(!Array.isArray(messages)||messages.length>5000)return res.status(400).json({error:'Messages must be a list of up to 5,000 entries.'});
    const gid=req.body.groupId===undefined?existing.group_id:id(req.body.groupId);if(gid && !(await ownedRow('groups',gid,req.session.userId)))return res.status(404).json({error:'Stock group not found.'});
    const q=await pool.query('UPDATE chats SET title=$1,messages=$2::jsonb,group_id=$3,updated_at=NOW() WHERE id=$4 AND user_id=$5 RETURNING *',[title,JSON.stringify(messages),gid,cid,req.session.userId]);res.json(q.rows[0]);
  } catch(e){safeError(res,e);}
});
app.delete('/api/chats/:id', auth, async (req,res) => {
  try { const cid=id(req.params.id);const q=await pool.query('DELETE FROM chats WHERE id=$1 AND user_id=$2 RETURNING id',[cid,req.session.userId]);if(!q.rowCount)return res.status(404).json({error:'Chat not found.'});res.json({ok:true}); } catch(e){safeError(res,e);}
});
app.get('/api/reconciliations', auth, async (req,res) => {
  try { const q=await pool.query(`SELECT r.id,r.title,r.stock_date,r.summary,r.created_at,r.chat_id,r.group_id,g.name AS group_name FROM reconciliations r LEFT JOIN stock_groups g ON g.id=r.group_id WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 500`,[req.session.userId]);res.json(q.rows); } catch(e){safeError(res,e);}
});
app.post('/api/reconciliations', auth, async (req,res) => {
  try {
    const body=req.body||{}; const cid=id(body.chatId), gid=id(body.groupId);
    if(cid && !(await ownedRow('chats',cid,req.session.userId)))return res.status(404).json({error:'Chat not found.'});
    if(gid && !(await ownedRow('groups',gid,req.session.userId)))return res.status(404).json({error:'Stock group not found.'});
    const arr=x=>Array.isArray(x)?x:[]; const title=String(body.title||'Stock reconciliation').trim().slice(0,180);
    const q=await pool.query(`INSERT INTO reconciliations(user_id,chat_id,group_id,title,stock_date,data1_name,data2_name,actual_rows,physical_rows,results,summary)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb) RETURNING *`,
      [req.session.userId,cid,gid,title||'Stock reconciliation',body.stockDate||null,String(body.data1Name||'Actual Quantity'),String(body.data2Name||'Physical Stock'),JSON.stringify(arr(body.actualRows)),JSON.stringify(arr(body.physicalRows)),JSON.stringify(arr(body.results)),JSON.stringify(body.summary||{})]);
    if(cid){ await pool.query('UPDATE chats SET updated_at=NOW() WHERE id=$1',[cid]); }
    res.status(201).json(q.rows[0]);
  } catch(e){safeError(res,e);}
});
app.get('/api/reconciliations/:id', auth, async (req,res) => {
  try { const r=await ownedRow('reconciliations',id(req.params.id),req.session.userId);if(!r)return res.status(404).json({error:'Report not found.'});res.json(r); } catch(e){safeError(res,e);}
});
app.delete('/api/reconciliations/:id', auth, async (req,res) => {
  try { const q=await pool.query('DELETE FROM reconciliations WHERE id=$1 AND user_id=$2 RETURNING id',[id(req.params.id),req.session.userId]);if(!q.rowCount)return res.status(404).json({error:'Report not found.'});res.json({ok:true}); } catch(e){safeError(res,e);}
});
app.get('/api/backup', auth, async (req,res) => {
  try {
    const uid=req.session.userId;
    const [groups,chats,recs,user]=await Promise.all([
      pool.query('SELECT id,name,created_at FROM stock_groups WHERE user_id=$1 ORDER BY id',[uid]),
      pool.query('SELECT id,group_id,title,messages,created_at,updated_at FROM chats WHERE user_id=$1 ORDER BY id',[uid]),
      pool.query('SELECT id,chat_id,group_id,title,stock_date,data1_name,data2_name,actual_rows,physical_rows,results,summary,created_at,updated_at FROM reconciliations WHERE user_id=$1 ORDER BY id',[uid]),
      pool.query('SELECT email,created_at FROM app_users WHERE id=$1',[uid])
    ]);
    const backup={format:'abhinav-stock-reconciliation-backup',version:1,exportedAt:new Date().toISOString(),account:user.rows[0],groups:groups.rows,chats:chats.rows,reconciliations:recs.rows};
    res.setHeader('Content-Disposition',`attachment; filename="stock-reconciliation-backup-${new Date().toISOString().slice(0,10)}.json"`);res.type('application/json').send(JSON.stringify(backup,null,2));
  } catch(e){safeError(res,e);}
});
app.post('/api/restore', auth, async (req,res) => {
  const backup=req.body;
  if(!backup || backup.format!=='abhinav-stock-reconciliation-backup' || backup.version!==1 || !Array.isArray(backup.groups)||!Array.isArray(backup.chats)||!Array.isArray(backup.reconciliations))return res.status(400).json({error:'Invalid or unsupported backup file.'});
  if(backup.groups.length>1000||backup.chats.length>10000||backup.reconciliations.length>10000)return res.status(413).json({error:'Backup contains too many records.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN'); const uid=req.session.userId;
    const mode=backup.restoreMode==='merge'?'merge':'replace';
    if(mode==='replace'){
      await client.query('DELETE FROM reconciliations WHERE user_id=$1',[uid]);
      await client.query('DELETE FROM chats WHERE user_id=$1',[uid]);
      await client.query('DELETE FROM stock_groups WHERE user_id=$1',[uid]);
    }
    const groupMap=new Map();
    for(const g of backup.groups){ const name=String(g.name||'Imported group').slice(0,100); let q=await client.query('SELECT id FROM stock_groups WHERE user_id=$1 AND name=$2',[uid,name]); if(!q.rowCount)q=await client.query('INSERT INTO stock_groups(user_id,name) VALUES($1,$2) RETURNING id',[uid,name]); groupMap.set(String(g.id),q.rows[0].id); }
    const chatMap=new Map();
    for(const c of backup.chats){ const gid=groupMap.get(String(c.group_id))||null; let q=await client.query('INSERT INTO chats(user_id,group_id,title,messages,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,COALESCE($5::timestamptz,NOW()),COALESCE($6::timestamptz,NOW())) RETURNING id',[uid,gid,String(c.title||'Imported chat').slice(0,160),JSON.stringify(Array.isArray(c.messages)?c.messages:[]),c.created_at||null,c.updated_at||null]);chatMap.set(String(c.id),q.rows[0].id); }
    for(const r of backup.reconciliations){ await client.query(`INSERT INTO reconciliations(user_id,chat_id,group_id,title,stock_date,data1_name,data2_name,actual_rows,physical_rows,results,summary,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,COALESCE($12::timestamptz,NOW()),COALESCE($13::timestamptz,NOW()))`,
      [uid,chatMap.get(String(r.chat_id))||null,groupMap.get(String(r.group_id))||null,String(r.title||'Imported report').slice(0,180),r.stock_date||null,String(r.data1_name||'Actual Quantity'),String(r.data2_name||'Physical Stock'),JSON.stringify(Array.isArray(r.actual_rows)?r.actual_rows:[]),JSON.stringify(Array.isArray(r.physical_rows)?r.physical_rows:[]),JSON.stringify(Array.isArray(r.results)?r.results:[]),JSON.stringify(r.summary||{}),r.created_at||null,r.updated_at||null]); }
    await client.query('COMMIT');res.json({ok:true,mode,groups:backup.groups.length,chats:backup.chats.length,reconciliations:backup.reconciliations.length});
  } catch(e){await client.query('ROLLBACK');safeError(res,e);} finally {client.release();}
});
app.get('/api/chats/:id/export.json', auth, async (req,res) => {
  try {const cid=id(req.params.id);const chat=await ownedRow('chats',cid,req.session.userId);if(!chat)return res.status(404).json({error:'Chat not found.'});const rec=await pool.query('SELECT * FROM reconciliations WHERE chat_id=$1 AND user_id=$2 ORDER BY created_at',[cid,req.session.userId]);const group=chat.group_id?await ownedRow('groups',chat.group_id,req.session.userId):null;
    const payload={format:'abhinav-stock-chat-backup',version:1,exportedAt:new Date().toISOString(),group,chat,reconciliations:rec.rows};res.setHeader('Content-Disposition',`attachment; filename="${String(chat.title).replace(/[^a-z0-9_-]+/gi,'_').slice(0,60)||'chat'}.json"`);res.json(payload);
  } catch(e){safeError(res,e);}
});
app.get('/api/reconciliations/:id/export.xlsx', auth, async (req,res) => {
  try {const r=await ownedRow('reconciliations',id(req.params.id),req.session.userId);if(!r)return res.status(404).json({error:'Report not found.'});const rows=Array.isArray(r.results)?r.results:[];const data=rows.map(x=>({'Data 1 Name':x.data1Name||'', 'Data 2 Name':x.data2Name||'', 'Data 1 Qty':x.actualQty??'', 'Data 2 Qty':x.physicalQty??'', 'Diff':x.diff??'', 'Status':x.status||'', 'Reason / Notes':x.reason||''}));
    const wb=XLSX.utils.book_new();const ws=XLSX.utils.json_to_sheet(data);ws['!cols']=[{wch:36},{wch:36},{wch:15},{wch:15},{wch:15},{wch:28},{wch:50}];XLSX.utils.book_append_sheet(wb,ws,'Reconciliation');const summary=[['Report',r.title],['Stock date',r.stock_date||''],['Exported at',new Date().toISOString()],['Summary',JSON.stringify(r.summary||{})]];XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(summary),'Summary');const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});res.setHeader('Content-Disposition',`attachment; filename="${String(r.title).replace(/[^a-z0-9_-]+/gi,'_').slice(0,60)||'reconciliation'}.xlsx"`);res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  } catch(e){safeError(res,e);}
});
app.get('*', (_req,res)=>res.sendFile(path.join(__dirname,'..','public','index.html')));

initDb().then(()=>{
  const server = app.listen(PORT,()=>console.log(`Stock Reconciliation listening on ${PORT}`));
  // Optional local self-ping loop for diagnostics/testing. This does NOT keep a Render
  // free web service awake: only inbound external traffic can affect Render's idle timer,
  // and an in-process timer stops when the service is suspended.
  const pingEnabled = String(process.env.SELF_PING_ENABLED || 'false').toLowerCase() === 'true';
  const pingIntervalMs = Math.max(15000, Number(process.env.SELF_PING_INTERVAL_MS || 60000));
  if (pingEnabled) {
    const pingUrl = `http://127.0.0.1:${PORT}/api/health`;
    const pingOnce = async () => {
      try {
        const response = await fetch(pingUrl, { signal: AbortSignal.timeout(10000) });
        // Intentionally no per-ping logging to avoid noisy logs.
        if (!response.ok) { /* next interval retries */ }
      } catch (_) { /* next interval retries; no sensitive details logged */ }
    };
    const timer = setInterval(pingOnce, pingIntervalMs);
    timer.unref();
    console.log(`Local self-ping diagnostics enabled (interval ${pingIntervalMs}ms); this does not prevent Render free-tier sleep.`);
  }
}).catch(err=>{console.error('Database initialization failed:',err.message);process.exit(1);});
