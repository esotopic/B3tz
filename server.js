const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// ── Database config ──
const DB_CONFIG = {
  server: process.env.DB_SERVER || '***REMOVED***',
  database: process.env.DB_NAME || '1000Problems',
  user: process.env.DB_USER || '***REMOVED***',
  password: process.env.DB_PASSWORD || '***REMOVED***',
  port: 1433,
  options: { encrypt: true, trustServerCertificate: false }
};

let sql; // will be loaded dynamically
let dbPool = null;

// ── Try to load mssql (installed via npm) ──
async function initDB() {
  try {
    sql = require('mssql');
    dbPool = await sql.connect({
      server: DB_CONFIG.server,
      database: DB_CONFIG.database,
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
      port: DB_CONFIG.port,
      options: DB_CONFIG.options,
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
      requestTimeout: 15000
    });
    console.log('Connected to Azure SQL');
    await ensureTables();
    return true;
  } catch (e) {
    console.log('DB not available, running in memory mode:', e.message);
    return false;
  }
}

// ── Create tables if they don't exist ──
async function ensureTables() {
  const query = `
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'B3tz_Users')
    BEGIN
      CREATE TABLE B3tz_Users (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Username NVARCHAR(50) NOT NULL UNIQUE,
        Email NVARCHAR(255) NOT NULL UNIQUE,
        PasswordHash NVARCHAR(128) NOT NULL,
        PasswordSalt NVARCHAR(64) NOT NULL,
        DisplayName NVARCHAR(100),
        CreatedDate DATETIME2 DEFAULT GETUTCDATE(),
        LastLoginDate DATETIME2
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'B3tz_Sessions')
    BEGIN
      CREATE TABLE B3tz_Sessions (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SessionToken NVARCHAR(128) NOT NULL UNIQUE,
        UserId INT NOT NULL,
        CreatedDate DATETIME2 DEFAULT GETUTCDATE(),
        ExpiresDate DATETIME2 NOT NULL,
        FOREIGN KEY (UserId) REFERENCES B3tz_Users(Id)
      );
      CREATE INDEX IX_B3tz_Sessions_Token ON B3tz_Sessions(SessionToken);
    END
  `;
  try {
    await dbPool.request().query(query);
    console.log('B3tz auth tables ready');
  } catch (e) {
    console.error('Table creation error:', e.message);
  }
}

// ── Password hashing ──
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, storedSalt) {
  const { hash } = hashPassword(password, storedSalt);
  return hash === storedHash;
}

// ── Session management ──
function generateSessionToken() {
  return crypto.randomBytes(48).toString('hex');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    if (key) cookies[key.trim()] = val.join('=').trim();
  });
  return cookies;
}

async function getUserFromSession(req) {
  if (!dbPool) return null;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['b3tz_session'];
  if (!token) return null;
  try {
    const result = await dbPool.request()
      .input('token', sql.NVarChar, token)
      .query(`
        SELECT u.Id, u.Username, u.Email, u.DisplayName
        FROM B3tz_Sessions s
        JOIN B3tz_Users u ON s.UserId = u.Id
        WHERE s.SessionToken = @token AND s.ExpiresDate > GETUTCDATE()
      `);
    return result.recordset[0] || null;
  } catch (e) {
    console.error('Session lookup error:', e.message);
    return null;
  }
}

// ── In-memory session store (fallback when no DB) ──
const memorySessions = {};
const memoryUsers = [];

function memGetUserFromSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['b3tz_session'];
  if (!token || !memorySessions[token]) return null;
  const session = memorySessions[token];
  if (new Date(session.expires) < new Date()) {
    delete memorySessions[token];
    return null;
  }
  return session.user;
}

// ── Request body parser ──
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── In-memory bet store ──
const bets = [
  { id: 1, title: "Russell will win Miami Grand Prix", category: "F1", event_date: "2026-05-03", created_by: "Angel", yes_odds: 34, no_odds: 66, yes_count: 127, no_count: 245, volume: 18600, status: "open", icon: "🏎️", featured: true },
  { id: 2, title: "Spain wins 2026 FIFA World Cup", category: "Soccer", event_date: "2026-07-19", created_by: "Carlos", yes_odds: 22, no_odds: 78, yes_count: 891, no_count: 3120, volume: 245000, status: "open", icon: "⚽", featured: true },
  { id: 3, title: "Bitcoin hits $200K before 2027", category: "Crypto", event_date: "2026-12-31", created_by: "Satoshi42", yes_odds: 41, no_odds: 59, yes_count: 2034, no_count: 2910, volume: 890000, status: "open", icon: "₿", featured: true },
  { id: 4, title: "AI passes bar exam with 99th percentile", category: "Tech", event_date: "2026-12-31", created_by: "TechWatcher", yes_odds: 73, no_odds: 27, yes_count: 456, no_count: 170, volume: 62000, status: "open", icon: "🤖" },
  { id: 5, title: "Lakers make NBA Finals 2026", category: "Basketball", event_date: "2026-06-15", created_by: "LakeShow", yes_odds: 18, no_odds: 82, yes_count: 312, no_count: 1420, volume: 95000, status: "open", icon: "🏀" },
  { id: 6, title: "Tesla releases sub-$25K vehicle in 2026", category: "Tech", event_date: "2026-12-31", created_by: "EVFanatic", yes_odds: 29, no_odds: 71, yes_count: 567, no_count: 1380, volume: 134000, status: "open", icon: "🚗" },
  { id: 7, title: "Ohtani hits 50+ HRs again in 2026", category: "Baseball", event_date: "2026-10-01", created_by: "DiamondDog", yes_odds: 38, no_odds: 62, yes_count: 890, no_count: 1450, volume: 78000, status: "open", icon: "⚾" },
  { id: 8, title: "Ethereum flips Bitcoin market cap", category: "Crypto", event_date: "2026-12-31", created_by: "DeFiMax", yes_odds: 8, no_odds: 92, yes_count: 234, no_count: 2700, volume: 156000, status: "open", icon: "⟠" },
  { id: 9, title: "US lands astronauts on Moon in 2026", category: "Science", event_date: "2026-12-31", created_by: "SpaceNerd", yes_odds: 15, no_odds: 85, yes_count: 345, no_count: 1960, volume: 210000, status: "open", icon: "🌙" },
  { id: 10, title: "Next GTA breaks day-one sales record", category: "Gaming", event_date: "2026-12-31", created_by: "PixelKing", yes_odds: 88, no_odds: 12, yes_count: 3400, no_count: 460, volume: 312000, status: "open", icon: "🎮" },
  { id: 11, title: "Verstappen wins F1 Championship 2026", category: "F1", event_date: "2026-12-15", created_by: "PitLane", yes_odds: 45, no_odds: 55, yes_count: 1230, no_count: 1500, volume: 178000, status: "open", icon: "🏎️" },
  { id: 12, title: "Drake drops album before summer 2026", category: "Music", event_date: "2026-06-21", created_by: "6ixGod", yes_odds: 52, no_odds: 48, yes_count: 678, no_count: 625, volume: 43000, status: "open", icon: "🎵" }
];

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff'
};

function sendJSON(res, statusCode, data, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}

function setCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

// ── Route handler ──
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── API: Register ──
  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await parseBody(req);
    const { username, email, password } = body;

    if (!username || !password) {
      return sendJSON(res, 400, { error: 'Username and password are required' });
    }
    if (username.length > 50) {
      return sendJSON(res, 400, { error: 'Username must be 50 characters or less' });
    }
    if (!email) email = username + '@b3tz.local'; // default placeholder if no email

    if (dbPool) {
      try {
        // Check if user exists
        const existing = await dbPool.request()
          .input('username', sql.NVarChar, username)
          .query('SELECT Id FROM B3tz_Users WHERE Username = @username');

        if (existing.recordset.length > 0) {
          return sendJSON(res, 409, { error: 'Username already taken' });
        }

        const { hash, salt } = hashPassword(password);
        const result = await dbPool.request()
          .input('username', sql.NVarChar, username)
          .input('email', sql.NVarChar, email)
          .input('hash', sql.NVarChar, hash)
          .input('salt', sql.NVarChar, salt)
          .input('display', sql.NVarChar, username)
          .query(`
            INSERT INTO B3tz_Users (Username, Email, PasswordHash, PasswordSalt, DisplayName)
            OUTPUT INSERTED.Id
            VALUES (@username, @email, @hash, @salt, @display)
          `);

        const userId = result.recordset[0].Id;
        const token = generateSessionToken();
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

        await dbPool.request()
          .input('token', sql.NVarChar, token)
          .input('userId', sql.Int, userId)
          .input('expires', sql.DateTime2, expires)
          .query('INSERT INTO B3tz_Sessions (SessionToken, UserId, ExpiresDate) VALUES (@token, @userId, @expires)');

        return sendJSON(res, 201, {
          user: { id: userId, username, email, displayName: username }
        }, { 'Set-Cookie': setCookie('b3tz_session', token, 30 * 24 * 3600) });

      } catch (e) {
        console.error('Register error:', e.message);
        return sendJSON(res, 500, { error: 'Server error during registration' });
      }
    } else {
      // Memory fallback
      if (memoryUsers.find(u => u.username === username)) {
        return sendJSON(res, 409, { error: 'Username already taken' });
      }
      const { hash, salt } = hashPassword(password);
      const user = { id: memoryUsers.length + 1, username, email, displayName: username, hash, salt };
      memoryUsers.push(user);
      const token = generateSessionToken();
      memorySessions[token] = { user: { id: user.id, username, email, displayName: username }, expires: new Date(Date.now() + 30*24*60*60*1000).toISOString() };
      return sendJSON(res, 201, {
        user: { id: user.id, username, email, displayName: username }
      }, { 'Set-Cookie': setCookie('b3tz_session', token, 30*24*3600) });
    }
  }

  // ── API: Login ──
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const { login, password } = body; // login = username or email

    if (!login || !password) {
      return sendJSON(res, 400, { error: 'Login and password are required' });
    }

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('login', sql.NVarChar, login)
          .query('SELECT Id, Username, Email, DisplayName, PasswordHash, PasswordSalt FROM B3tz_Users WHERE Username = @login OR Email = @login');

        const user = result.recordset[0];
        if (!user || !verifyPassword(password, user.PasswordHash, user.PasswordSalt)) {
          return sendJSON(res, 401, { error: 'Invalid username or password' });
        }

        // Update last login
        await dbPool.request()
          .input('id', sql.Int, user.Id)
          .query('UPDATE B3tz_Users SET LastLoginDate = GETUTCDATE() WHERE Id = @id');

        const token = generateSessionToken();
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        await dbPool.request()
          .input('token', sql.NVarChar, token)
          .input('userId', sql.Int, user.Id)
          .input('expires', sql.DateTime2, expires)
          .query('INSERT INTO B3tz_Sessions (SessionToken, UserId, ExpiresDate) VALUES (@token, @userId, @expires)');

        return sendJSON(res, 200, {
          user: { id: user.Id, username: user.Username, email: user.Email, displayName: user.DisplayName }
        }, { 'Set-Cookie': setCookie('b3tz_session', token, 30*24*3600) });

      } catch (e) {
        console.error('Login error:', e.message);
        return sendJSON(res, 500, { error: 'Server error during login' });
      }
    } else {
      // Memory fallback
      const user = memoryUsers.find(u => u.username === login || u.email === login);
      if (!user || !verifyPassword(password, user.hash, user.salt)) {
        return sendJSON(res, 401, { error: 'Invalid username or password' });
      }
      const token = generateSessionToken();
      memorySessions[token] = { user: { id: user.id, username: user.username, email: user.email, displayName: user.displayName }, expires: new Date(Date.now() + 30*24*60*60*1000).toISOString() };
      return sendJSON(res, 200, {
        user: { id: user.id, username: user.username, email: user.email, displayName: user.displayName }
      }, { 'Set-Cookie': setCookie('b3tz_session', token, 30*24*3600) });
    }
  }

  // ── API: Get current user ──
  if (pathname === '/api/me' && req.method === 'GET') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { user: null });
    return sendJSON(res, 200, { user });
  }

  // ── API: Logout ──
  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['b3tz_session'];
    if (token && dbPool) {
      try {
        await dbPool.request()
          .input('token', sql.NVarChar, token)
          .query('DELETE FROM B3tz_Sessions WHERE SessionToken = @token');
      } catch (e) { /* ignore */ }
    }
    if (token && memorySessions[token]) delete memorySessions[token];
    return sendJSON(res, 200, { ok: true }, {
      'Set-Cookie': setCookie('b3tz_session', '', 0)
    });
  }

  // ── API: Bets ──
  if (pathname === '/api/bets' && req.method === 'GET') {
    return sendJSON(res, 200, { bets });
  }

  if (pathname === '/api/categories' && req.method === 'GET') {
    const categories = [...new Set(bets.map(b => b.category))];
    return sendJSON(res, 200, { categories });
  }

  // ── Static file serving ──
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, 'public', filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer(handleRequest);

// ── Start ──
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`B3tz running on port ${PORT}`);
  });
});
