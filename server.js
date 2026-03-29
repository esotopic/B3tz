const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// ── Claude API config ──
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

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

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'B3tz_Bets')
    BEGIN
      CREATE TABLE B3tz_Bets (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Title NVARCHAR(300) NOT NULL,
        Category NVARCHAR(50) NOT NULL DEFAULT 'General',
        Icon NVARCHAR(10) DEFAULT '🎲',
        EventDate NVARCHAR(50),
        ResolutionCriteria NVARCHAR(2000),
        OriginalInput NVARCHAR(1000),
        CreatedByUserId INT,
        CreatedByName NVARCHAR(100),
        YesOdds INT DEFAULT 50,
        NoOdds INT DEFAULT 50,
        YesCount INT DEFAULT 0,
        NoCount INT DEFAULT 0,
        Volume INT DEFAULT 0,
        Status NVARCHAR(20) DEFAULT 'open',
        Resolution NVARCHAR(10),
        ResolutionReason NVARCHAR(2000),
        ResolvedDate DATETIME2,
        Featured BIT DEFAULT 0,
        CreatedDate DATETIME2 DEFAULT GETUTCDATE()
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'B3tz_UserBets')
    BEGIN
      CREATE TABLE B3tz_UserBets (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        UserId INT NOT NULL,
        BetId INT NOT NULL,
        Side NVARCHAR(3) NOT NULL,
        PlacedDate DATETIME2 DEFAULT GETUTCDATE(),
        FOREIGN KEY (UserId) REFERENCES B3tz_Users(Id),
        FOREIGN KEY (BetId) REFERENCES B3tz_Bets(Id)
      );
      CREATE UNIQUE INDEX IX_B3tz_UserBets_Unique ON B3tz_UserBets(UserId, BetId);
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'B3tz_Challenges')
    BEGIN
      CREATE TABLE B3tz_Challenges (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Code NVARCHAR(20) NOT NULL UNIQUE,
        SenderUserId INT NOT NULL,
        BetId INT NOT NULL,
        SenderSide NVARCHAR(3),
        RecipientUserId INT,
        CreatedDate DATETIME2 DEFAULT GETUTCDATE(),
        ClaimedDate DATETIME2,
        FOREIGN KEY (SenderUserId) REFERENCES B3tz_Users(Id),
        FOREIGN KEY (BetId) REFERENCES B3tz_Bets(Id)
      );
      CREATE INDEX IX_B3tz_Challenges_Code ON B3tz_Challenges(Code);
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'B3tz_Rivals')
    BEGIN
      CREATE TABLE B3tz_Rivals (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        UserId INT NOT NULL,
        RivalUserId INT NOT NULL,
        Source NVARCHAR(20) DEFAULT 'challenge',
        CreatedDate DATETIME2 DEFAULT GETUTCDATE(),
        FOREIGN KEY (UserId) REFERENCES B3tz_Users(Id),
        FOREIGN KEY (RivalUserId) REFERENCES B3tz_Users(Id)
      );
      CREATE UNIQUE INDEX IX_B3tz_Rivals_Unique ON B3tz_Rivals(UserId, RivalUserId);
    END
  `;
  try {
    await dbPool.request().query(query);
    console.log('B3tz tables ready (Users, Sessions, Bets, UserBets, Challenges, Rivals)');
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

// ══════════════════════════════════════
// ── CLAUDE API: Bet Validation ──
// ══════════════════════════════════════

function callClaudeAPI(messages, systemPrompt, tools) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages,
      ...(tools ? { tools } : {})
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        ...(tools ? { 'anthropic-beta': 'tools-2024-04-04' } : {})
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Failed to parse Claude response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Claude API timeout')); });
    req.write(body);
    req.end();
  });
}

// Simple web search via a fetch to a search API
function webSearch(query) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    // Use DuckDuckGo instant answer API for quick factual lookups
    const options = {
      hostname: 'api.duckduckgo.com',
      path: `/?q=${encodedQuery}&format=json&no_redirect=1&no_html=1`,
      method: 'GET',
      headers: { 'User-Agent': 'B3tz/1.0' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          resolve({ Abstract: '', Results: [] });
        }
      });
    });

    req.on('error', () => resolve({ Abstract: '', Results: [] }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ Abstract: '', Results: [] }); });
    req.end();
  });
}

// Fetch a web page's text content (for arbitration research)
function fetchURL(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'B3tz/1.0' }, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 50000) res.destroy(); });
      res.on('end', () => resolve(data.slice(0, 50000)));
    });
    req.on('error', () => resolve(''));
    req.setTimeout(8000, () => { req.destroy(); resolve(''); });
  });
}

// ── Validate & structure a bet using Claude ──
async function validateBetWithAI(userInput) {
  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are the B3tz bet validator. Your job is to take a user's natural language bet and turn it into a structured, verifiable bet.

Today's date: ${today}

Rules:
1. The bet MUST be about a future event with an objectively verifiable yes/no outcome.
2. Reject bets about subjective opinions ("pizza is the best food") — these can't be resolved.
3. Reject bets about events that have ALREADY happened and whose outcome is known.
4. If the event date is uncertain or could change (e.g. elections, product launches), note that in the resolution criteria. Use language like "when the event occurs" rather than locking to a specific date.
5. Provide a clear title (concise, max 80 chars), a category, an icon emoji, an estimated event date, and detailed resolution criteria.
6. The resolution criteria should describe EXACTLY how this bet will be resolved — what constitutes a YES and what constitutes a NO. Be specific enough that anyone could verify it.
7. If the bet is ambiguous, ask a clarifying question instead of guessing.

Respond with ONLY a JSON object (no markdown, no code fences) in one of these formats:

If VALID bet:
{"status":"valid","title":"...","category":"...","icon":"...","event_date":"YYYY-MM-DD","resolution_criteria":"...","needs_clarification":false}

If NEEDS CLARIFICATION:
{"status":"clarify","question":"...","suggestions":["option1","option2"]}

If INVALID (subjective, already happened, nonsensical):
{"status":"invalid","reason":"..."}

Categories to choose from: F1, Soccer, Basketball, Baseball, Crypto, Tech, Science, Gaming, Music, Politics, Entertainment, Sports, General`;

  const response = await callClaudeAPI(
    [{ role: 'user', content: `Validate this bet: "${userInput}"` }],
    systemPrompt
  );

  const text = response.content[0].text.trim();
  // Parse JSON — handle potential markdown wrapping
  const jsonStr = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(jsonStr);
}

// ── Arbitrate a bet using Claude + web search ──
async function arbitrateBetWithAI(bet) {
  const today = new Date().toISOString().split('T')[0];

  // Step 1: Do web research on the bet topic
  const searchQueries = [
    bet.Title + ' result ' + new Date().getFullYear(),
    bet.Title + ' outcome winner',
  ];

  let searchResults = '';
  for (const query of searchQueries) {
    const ddg = await webSearch(query);
    if (ddg.Abstract) searchResults += `Search "${query}": ${ddg.Abstract}\n`;
    if (ddg.Answer) searchResults += `Answer: ${ddg.Answer}\n`;
    if (ddg.RelatedTopics && ddg.RelatedTopics.length > 0) {
      const topics = ddg.RelatedTopics.slice(0, 3).map(t => t.Text || '').filter(Boolean);
      if (topics.length > 0) searchResults += `Related: ${topics.join('; ')}\n`;
    }
  }

  // Step 2: Ask Claude to arbitrate based on research
  const systemPrompt = `You are the B3tz bet arbitrator. You must determine whether an open bet can be resolved based on available information.

Today's date: ${today}

The bet details:
- Title: ${bet.Title}
- Resolution Criteria: ${bet.ResolutionCriteria || 'Resolves YES if the stated event occurs, NO otherwise.'}
- Event Date: ${bet.EventDate || 'Not specified'}
- Created: ${bet.CreatedDate}

Web search results about this bet:
${searchResults || 'No relevant search results found.'}

Your job:
1. Determine if this bet's outcome is NOW KNOWN based on available evidence.
2. If the event hasn't happened yet, or the outcome is unclear, say it's still pending.
3. If the outcome IS known, state whether it resolves YES or NO and explain why.
4. Be CONSERVATIVE — only resolve if you are highly confident the outcome is settled.

Respond with ONLY a JSON object (no markdown, no code fences):

If still pending (event hasn't happened or outcome unknown):
{"status":"pending","reason":"Brief explanation of why it can't be resolved yet"}

If resolved:
{"status":"resolved","resolution":"yes" or "no","reason":"Clear explanation of the outcome with evidence"}`;

  const response = await callClaudeAPI(
    [{ role: 'user', content: `Arbitrate this bet. Search results and bet details are in the system prompt.` }],
    systemPrompt
  );

  const text = response.content[0].text.trim();
  const jsonStr = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(jsonStr);
}

// ══════════════════════════════
// ── In-memory bet store (seed data) ──
// ══════════════════════════════

const seedBets = [
  { id: 1, title: "Russell will win Miami Grand Prix", category: "F1", event_date: "2026-05-03", created_by: "Angel", yes_odds: 34, no_odds: 66, yes_count: 127, no_count: 245, volume: 18600, status: "open", icon: "🏎️", featured: true, resolution_criteria: "Resolves YES if George Russell is declared the official winner of the 2026 Miami Grand Prix. Resolves NO otherwise. If the race is postponed, resolution follows the rescheduled date." },
  { id: 2, title: "Spain wins 2026 FIFA World Cup", category: "Soccer", event_date: "2026-07-19", created_by: "Carlos", yes_odds: 22, no_odds: 78, yes_count: 891, no_count: 3120, volume: 245000, status: "open", icon: "⚽", featured: true, resolution_criteria: "Resolves YES if Spain's national football team wins the 2026 FIFA World Cup Final. Resolves NO otherwise." },
  { id: 3, title: "Bitcoin hits $200K before 2027", category: "Crypto", event_date: "2026-12-31", created_by: "Satoshi42", yes_odds: 41, no_odds: 59, yes_count: 2034, no_count: 2910, volume: 890000, status: "open", icon: "₿", featured: true, resolution_criteria: "Resolves YES if Bitcoin (BTC) reaches a price of $200,000 USD or higher on any major exchange before January 1, 2027. Resolves NO if it does not reach this price by that date." },
  { id: 4, title: "AI passes bar exam with 99th percentile", category: "Tech", event_date: "2026-12-31", created_by: "TechWatcher", yes_odds: 73, no_odds: 27, yes_count: 456, no_count: 170, volume: 62000, status: "open", icon: "🤖", resolution_criteria: "Resolves YES if any AI system publicly achieves a 99th percentile score on the Uniform Bar Examination by end of 2026." },
  { id: 5, title: "Lakers make NBA Finals 2026", category: "Basketball", event_date: "2026-06-15", created_by: "LakeShow", yes_odds: 18, no_odds: 82, yes_count: 312, no_count: 1420, volume: 95000, status: "open", icon: "🏀", resolution_criteria: "Resolves YES if the Los Angeles Lakers reach the 2026 NBA Finals. Resolves NO if eliminated before the Finals." },
  { id: 6, title: "Tesla releases sub-$25K vehicle in 2026", category: "Tech", event_date: "2026-12-31", created_by: "EVFanatic", yes_odds: 29, no_odds: 71, yes_count: 567, no_count: 1380, volume: 134000, status: "open", icon: "🚗", resolution_criteria: "Resolves YES if Tesla begins sales or deliveries of a vehicle with a base MSRP under $25,000 USD during 2026." },
  { id: 7, title: "Ohtani hits 50+ HRs again in 2026", category: "Baseball", event_date: "2026-10-01", created_by: "DiamondDog", yes_odds: 38, no_odds: 62, yes_count: 890, no_count: 1450, volume: 78000, status: "open", icon: "⚾", resolution_criteria: "Resolves YES if Shohei Ohtani hits 50 or more home runs in the 2026 MLB regular season." },
  { id: 8, title: "Ethereum flips Bitcoin market cap", category: "Crypto", event_date: "2026-12-31", created_by: "DeFiMax", yes_odds: 8, no_odds: 92, yes_count: 234, no_count: 2700, volume: 156000, status: "open", icon: "⟠", resolution_criteria: "Resolves YES if Ethereum's total market capitalization exceeds Bitcoin's at any point during 2026 on CoinMarketCap or CoinGecko." },
  { id: 9, title: "US lands astronauts on Moon in 2026", category: "Science", event_date: "2026-12-31", created_by: "SpaceNerd", yes_odds: 15, no_odds: 85, yes_count: 345, no_count: 1960, volume: 210000, status: "open", icon: "🌙", resolution_criteria: "Resolves YES if NASA's Artemis program successfully lands astronauts on the lunar surface during 2026. Resolves NO if the mission is delayed beyond 2026." },
  { id: 10, title: "Next GTA breaks day-one sales record", category: "Gaming", event_date: "2026-12-31", created_by: "PixelKing", yes_odds: 88, no_odds: 12, yes_count: 3400, no_count: 460, volume: 312000, status: "open", icon: "🎮", resolution_criteria: "Resolves YES if Grand Theft Auto VI breaks the existing record for day-one video game sales when it launches." },
  { id: 11, title: "Verstappen wins F1 Championship 2026", category: "F1", event_date: "2026-12-15", created_by: "PitLane", yes_odds: 45, no_odds: 55, yes_count: 1230, no_count: 1500, volume: 178000, status: "open", icon: "🏎️", resolution_criteria: "Resolves YES if Max Verstappen wins the 2026 FIA Formula One World Drivers' Championship." },
  { id: 12, title: "Drake drops album before summer 2026", category: "Music", event_date: "2026-06-21", created_by: "6ixGod", yes_odds: 52, no_odds: 48, yes_count: 678, no_count: 625, volume: 43000, status: "open", icon: "🎵", resolution_criteria: "Resolves YES if Drake releases a new studio album before June 21, 2026 (first day of summer). Singles and EPs do not count." }
];

// In-memory bets (used if DB not available, or as cache)
let bets = [...seedBets];

// Load bets from DB on startup (if available)
async function loadBetsFromDB() {
  if (!dbPool) return;
  try {
    const result = await dbPool.request().query('SELECT * FROM B3tz_Bets ORDER BY CreatedDate DESC');
    if (result.recordset.length === 0) {
      // Seed DB with initial bets
      for (const bet of seedBets) {
        await dbPool.request()
          .input('title', sql.NVarChar, bet.title)
          .input('category', sql.NVarChar, bet.category)
          .input('icon', sql.NVarChar, bet.icon)
          .input('eventDate', sql.NVarChar, bet.event_date)
          .input('resCriteria', sql.NVarChar, bet.resolution_criteria)
          .input('createdBy', sql.NVarChar, bet.created_by)
          .input('yesOdds', sql.Int, bet.yes_odds)
          .input('noOdds', sql.Int, bet.no_odds)
          .input('yesCount', sql.Int, bet.yes_count)
          .input('noCount', sql.Int, bet.no_count)
          .input('volume', sql.Int, bet.volume)
          .input('featured', sql.Bit, bet.featured ? 1 : 0)
          .query(`INSERT INTO B3tz_Bets (Title, Category, Icon, EventDate, ResolutionCriteria, CreatedByName, YesOdds, NoOdds, YesCount, NoCount, Volume, Featured)
                  VALUES (@title, @category, @icon, @eventDate, @resCriteria, @createdBy, @yesOdds, @noOdds, @yesCount, @noCount, @volume, @featured)`);
      }
      console.log('Seeded B3tz_Bets with initial data');
      // Reload
      const r2 = await dbPool.request().query('SELECT * FROM B3tz_Bets ORDER BY CreatedDate DESC');
      bets = r2.recordset.map(dbBetToApi);
    } else {
      bets = result.recordset.map(dbBetToApi);
    }
  } catch (e) {
    console.error('Error loading bets from DB:', e.message);
  }
}

function dbBetToApi(row) {
  return {
    id: row.Id,
    title: row.Title,
    category: row.Category || 'General',
    icon: row.Icon || '🎲',
    event_date: row.EventDate || '',
    created_by: row.CreatedByName || 'Anonymous',
    created_by_user_id: row.CreatedByUserId || null,
    yes_odds: row.YesOdds || 50,
    no_odds: row.NoOdds || 50,
    yes_count: row.YesCount || 0,
    no_count: row.NoCount || 0,
    volume: row.Volume || 0,
    status: row.Status || 'open',
    resolution: row.Resolution || null,
    resolution_reason: row.ResolutionReason || null,
    resolution_criteria: row.ResolutionCriteria || '',
    featured: !!row.Featured,
    created_date: row.CreatedDate
  };
}

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

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function generateChallengeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ══════════════════════════════
// ── Route handler ──
// ══════════════════════════════

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── API: Register ──
  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await parseBody(req);
    let { username, email, password } = body;

    if (!username || !password) {
      return sendJSON(res, 400, { error: 'Username and password are required' });
    }
    if (username.length > 50) {
      return sendJSON(res, 400, { error: 'Username must be 50 characters or less' });
    }
    if (!email) email = username + '@b3tz.local';

    if (dbPool) {
      try {
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
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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
    const { login, password } = body;

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

  // ── API: Place a bet (record user's pick) ──
  if (pathname === '/api/bets/place' && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in to place bets' });

    const body = await parseBody(req);
    const { betId, side, challengeCode } = body;
    const betSide = side === 'no' ? 'no' : 'yes';
    const userId = user.Id || user.id;

    const bet = bets.find(b => b.id === betId);
    if (!bet) return sendJSON(res, 404, { error: 'Bet not found' });
    if (bet.status !== 'open') return sendJSON(res, 400, { error: 'Bet is already resolved' });

    if (dbPool) {
      try {
        // Check if user already bet on this
        const existing = await dbPool.request()
          .input('userId', sql.Int, userId)
          .input('betId', sql.Int, betId)
          .query('SELECT Id, Side FROM B3tz_UserBets WHERE UserId = @userId AND BetId = @betId');

        if (existing.recordset.length > 0) {
          const oldSide = existing.recordset[0].Side;
          if (oldSide === betSide) {
            return sendJSON(res, 200, { message: 'Already bet this side', side: betSide, changed: false });
          }
          // Switch sides
          await dbPool.request()
            .input('id', sql.Int, existing.recordset[0].Id)
            .input('side', sql.NVarChar, betSide)
            .query('UPDATE B3tz_UserBets SET Side = @side, PlacedDate = GETUTCDATE() WHERE Id = @id');

          // Update counts: remove from old, add to new
          const yesAdj = betSide === 'yes' ? 1 : -1;
          const noAdj = betSide === 'no' ? 1 : -1;
          await dbPool.request()
            .input('betId', sql.Int, betId)
            .input('yesAdj', sql.Int, yesAdj)
            .input('noAdj', sql.Int, noAdj)
            .query('UPDATE B3tz_Bets SET YesCount = YesCount + @yesAdj, NoCount = NoCount + @noAdj WHERE Id = @betId');

          bet.yes_count += yesAdj;
          bet.no_count += noAdj;
        } else {
          // New bet placement
          await dbPool.request()
            .input('userId', sql.Int, userId)
            .input('betId', sql.Int, betId)
            .input('side', sql.NVarChar, betSide)
            .query('INSERT INTO B3tz_UserBets (UserId, BetId, Side) VALUES (@userId, @betId, @side)');

          const field = betSide === 'yes' ? 'YesCount' : 'NoCount';
          await dbPool.request()
            .input('betId', sql.Int, betId)
            .query(`UPDATE B3tz_Bets SET ${field} = ${field} + 1 WHERE Id = @betId`);

          if (betSide === 'yes') bet.yes_count++;
          else bet.no_count++;
        }

        // Recalculate odds
        const total = bet.yes_count + bet.no_count;
        if (total > 0) {
          bet.yes_odds = Math.round((bet.yes_count / total) * 100);
          bet.no_odds = 100 - bet.yes_odds;
          await dbPool.request()
            .input('betId', sql.Int, betId)
            .input('yesOdds', sql.Int, bet.yes_odds)
            .input('noOdds', sql.Int, bet.no_odds)
            .query('UPDATE B3tz_Bets SET YesOdds = @yesOdds, NoOdds = @noOdds WHERE Id = @betId');
        }

        // Claim challenge if provided → auto-create mutual rivalry
        let rivalCreated = false;
        if (challengeCode && dbPool) {
          try {
            const chResult = await dbPool.request()
              .input('code', sql.NVarChar, challengeCode)
              .query('SELECT Id, SenderUserId, BetId FROM B3tz_Challenges WHERE Code = @code AND ClaimedDate IS NULL');
            if (chResult.recordset.length > 0) {
              const ch = chResult.recordset[0];
              if (ch.SenderUserId !== userId && ch.BetId === betId) {
                // Claim the challenge
                await dbPool.request()
                  .input('id', sql.Int, ch.Id)
                  .input('recipientId', sql.Int, userId)
                  .query('UPDATE B3tz_Challenges SET RecipientUserId = @recipientId, ClaimedDate = GETUTCDATE() WHERE Id = @id');
                // Create mutual rival entries (both directions)
                try {
                  await dbPool.request()
                    .input('u1', sql.Int, ch.SenderUserId)
                    .input('u2', sql.Int, userId)
                    .query(`
                      IF NOT EXISTS (SELECT 1 FROM B3tz_Rivals WHERE UserId = @u1 AND RivalUserId = @u2)
                        INSERT INTO B3tz_Rivals (UserId, RivalUserId, Source) VALUES (@u1, @u2, 'challenge');
                      IF NOT EXISTS (SELECT 1 FROM B3tz_Rivals WHERE UserId = @u2 AND RivalUserId = @u1)
                        INSERT INTO B3tz_Rivals (UserId, RivalUserId, Source) VALUES (@u2, @u1, 'challenge');
                    `);
                  rivalCreated = true;
                } catch (re) {
                  console.error('Rival creation error:', re.message);
                }
              }
            }
          } catch (ce) {
            console.error('Challenge claim error:', ce.message);
          }
        }

        return sendJSON(res, 200, { message: 'Bet placed', side: betSide, changed: true, bet, rivalCreated });
      } catch (e) {
        console.error('Place bet error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to place bet' });
      }
    } else {
      // Memory mode — just update counts
      if (betSide === 'yes') bet.yes_count++;
      else bet.no_count++;
      const total = bet.yes_count + bet.no_count;
      bet.yes_odds = Math.round((bet.yes_count / total) * 100);
      bet.no_odds = 100 - bet.yes_odds;
      return sendJSON(res, 200, { message: 'Bet placed', side: betSide, changed: true, bet });
    }
  }

  // ── API: Get user's bets ──
  if (pathname === '/api/my-bets' && req.method === 'GET') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });

    const userId = user.Id || user.id;

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('userId', sql.Int, userId)
          .query(`SELECT ub.BetId, ub.Side, ub.PlacedDate FROM B3tz_UserBets ub WHERE ub.UserId = @userId ORDER BY ub.PlacedDate DESC`);

        const userBets = result.recordset.map(r => ({
          betId: r.BetId,
          side: r.Side,
          placedDate: r.PlacedDate
        }));

        return sendJSON(res, 200, { userBets });
      } catch (e) {
        console.error('My bets error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to load your bets' });
      }
    } else {
      return sendJSON(res, 200, { userBets: [] });
    }
  }

  // ══════════════════════════════════
  // ── API: Get Bet Voters ──
  // ══════════════════════════════════

  const votersMatch = pathname.match(/^\/api\/bets\/(\d+)\/voters$/);
  if (votersMatch && req.method === 'GET') {
    const betId = parseInt(votersMatch[1]);

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('betId', sql.Int, betId)
          .query(`
            SELECT u.Id, u.Username, u.DisplayName, ub.Side, ub.PlacedDate
            FROM B3tz_UserBets ub
            JOIN B3tz_Users u ON u.Id = ub.UserId
            WHERE ub.BetId = @betId
            ORDER BY ub.PlacedDate ASC
          `);

        const yesVoters = result.recordset
          .filter(r => r.Side === 'yes')
          .map(r => ({ id: r.Id, username: r.Username, displayName: r.DisplayName || r.Username }));
        const noVoters = result.recordset
          .filter(r => r.Side === 'no')
          .map(r => ({ id: r.Id, username: r.Username, displayName: r.DisplayName || r.Username }));

        return sendJSON(res, 200, { yesVoters, noVoters });
      } catch (e) {
        console.error('Voters error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to load voters' });
      }
    } else {
      return sendJSON(res, 200, { yesVoters: [], noVoters: [] });
    }
  }

  // ══════════════════════════════════════
  // ── API: Create Challenge ──
  // ══════════════════════════════════════

  if (pathname === '/api/challenges' && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in to send challenges' });

    const body = await parseBody(req);
    const { betId, side } = body;
    if (!betId) return sendJSON(res, 400, { error: 'betId required' });

    const bet = bets.find(b => b.id === parseInt(betId));
    if (!bet) return sendJSON(res, 404, { error: 'Bet not found' });

    const userId = user.Id || user.id;
    const displayName = user.DisplayName || user.Username || user.username;
    const code = generateChallengeCode();

    if (dbPool) {
      try {
        await dbPool.request()
          .input('code', sql.NVarChar, code)
          .input('senderId', sql.Int, userId)
          .input('betId', sql.Int, parseInt(betId))
          .input('side', sql.NVarChar, side || null)
          .query(`INSERT INTO B3tz_Challenges (Code, SenderUserId, BetId, SenderSide) VALUES (@code, @senderId, @betId, @side)`);
      } catch (e) {
        console.error('Create challenge error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to create challenge' });
      }
    }

    const host = req.headers.host || 'b3tz.1000problems.com';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const challengeUrl = `${protocol}://${host}/c/${code}`;

    // Build share text
    const sideText = side ? (side === 'yes' ? 'YES' : 'NO') : '';
    const oddsText = side ? ` (${side === 'yes' ? bet.yes_odds : bet.no_odds}% odds)` : '';
    const shareText = `${bet.icon} ${displayName} bet ${sideText} on "${bet.title}"${oddsText} — think you know better?\n\n${challengeUrl}`;

    return sendJSON(res, 201, { code, url: challengeUrl, shareText, bet: { title: bet.title, icon: bet.icon } });
  }

  // ══════════════════════════════════════
  // ── API: Get Challenge Info ──
  // ══════════════════════════════════════

  if (pathname === '/api/challenges' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) return sendJSON(res, 400, { error: 'code required' });

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('code', sql.NVarChar, code)
          .query(`
            SELECT c.Id, c.Code, c.SenderUserId, c.BetId, c.SenderSide, c.RecipientUserId, c.CreatedDate, c.ClaimedDate,
                   u.Username AS SenderUsername, u.DisplayName AS SenderDisplayName
            FROM B3tz_Challenges c
            JOIN B3tz_Users u ON c.SenderUserId = u.Id
            WHERE c.Code = @code
          `);
        if (result.recordset.length === 0) return sendJSON(res, 404, { error: 'Challenge not found' });
        const ch = result.recordset[0];
        return sendJSON(res, 200, {
          challenge: {
            id: ch.Id, code: ch.Code, betId: ch.BetId, senderSide: ch.SenderSide,
            senderName: ch.SenderDisplayName || ch.SenderUsername,
            claimed: !!ch.ClaimedDate
          }
        });
      } catch (e) {
        console.error('Get challenge error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to load challenge' });
      }
    } else {
      return sendJSON(res, 404, { error: 'Challenge not found' });
    }
  }

  // ══════════════════════════════════════════════════
  // ── Challenge Link: /c/:code → OG tags + redirect ──
  // ══════════════════════════════════════════════════

  const challengeMatch = pathname.match(/^\/c\/([A-Za-z0-9]+)$/);
  if (challengeMatch && req.method === 'GET') {
    const code = challengeMatch[1];

    // Default OG values
    let ogTitle = 'You\'ve been challenged on B3tz!';
    let ogDesc = 'Someone dared you to pick a side. Think you know better?';
    let ogBetTitle = '';
    let ogSenderName = 'Someone';
    let ogSenderSide = '';
    let ogBetId = '';
    let ogOdds = '';
    let ogIcon = '🎲';

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('code', sql.NVarChar, code)
          .query(`
            SELECT c.BetId, c.SenderSide, u.Username, u.DisplayName,
                   b.Title, b.Icon, b.YesOdds, b.NoOdds, b.Category, b.YesCount, b.NoCount
            FROM B3tz_Challenges c
            JOIN B3tz_Users u ON c.SenderUserId = u.Id
            JOIN B3tz_Bets b ON c.BetId = b.Id
            WHERE c.Code = @code
          `);
        if (result.recordset.length > 0) {
          const r = result.recordset[0];
          ogSenderName = r.DisplayName || r.Username;
          ogBetTitle = r.Title;
          ogIcon = r.Icon || '🎲';
          ogBetId = r.BetId;
          ogSenderSide = r.SenderSide;
          ogOdds = r.SenderSide === 'yes' ? r.YesOdds : r.SenderSide === 'no' ? r.NoOdds : '';
          ogTitle = `${ogIcon} ${ogSenderName} challenged you!`;
          const sideLabel = ogSenderSide ? (ogSenderSide === 'yes' ? 'YES' : 'NO') : '';
          ogDesc = ogSenderSide
            ? `${ogSenderName} bet ${sideLabel} on "${ogBetTitle}"${ogOdds ? ` (${ogOdds}%)` : ''}. Think you know better?`
            : `${ogSenderName} wants you to bet on "${ogBetTitle}". Pick a side!`;
        }
      } catch (e) {
        console.error('Challenge OG lookup error:', e.message);
      }
    }

    // Serve HTML with OpenGraph + Twitter Card meta tags, then redirect to app
    const ogUrl = `https://b3tz.1000problems.com/c/${code}`;
    const ogImage = `https://b3tz.1000problems.com/og-card.png`;
    const redirectUrl = ogBetId ? `/#bet/${ogBetId}?challenge=${code}` : '/';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(ogTitle)} | B3tz</title>

  <!-- OpenGraph (Facebook, iMessage, WhatsApp, Telegram) -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${ogUrl}">
  <meta property="og:title" content="${escapeHtml(ogTitle)}">
  <meta property="og:description" content="${escapeHtml(ogDesc)}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:site_name" content="B3tz — Find Your Nemesis">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}">
  <meta name="twitter:description" content="${escapeHtml(ogDesc)}">
  <meta name="twitter:image" content="${ogImage}">

  <!-- Redirect to app after crawlers read the meta tags -->
  <meta http-equiv="refresh" content="0;url=${redirectUrl}">
  <style>
    body { background: #0a0b0f; color: #e8e8ed; font-family: -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .loading { text-align: center; }
    .loading h2 { margin-bottom: 8px; }
    a { color: #7c4dff; }
  </style>
</head>
<body>
  <div class="loading">
    <h2>${escapeHtml(ogTitle)}</h2>
    <p>${escapeHtml(ogDesc)}</p>
    <p>Redirecting to B3tz... <a href="${redirectUrl}">Click here if not redirected</a></p>
  </div>
  <script>window.location.replace("${redirectUrl}");</script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ══════════════════════════════════
  // ── API: AI Bet Validation ──
  // ══════════════════════════════════

  if (pathname === '/api/ai/validate-bet' && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in to create bets' });

    const body = await parseBody(req);
    const { input } = body;

    if (!input || input.trim().length < 5) {
      return sendJSON(res, 400, { error: 'Please describe your bet in more detail' });
    }

    try {
      const result = await validateBetWithAI(input.trim());
      return sendJSON(res, 200, { result });
    } catch (e) {
      console.error('AI validation error:', e.message);
      return sendJSON(res, 500, { error: 'AI validation failed. Please try again.' });
    }
  }

  // ══════════════════════════════════
  // ── API: Create Bet (AI-validated) ──
  // ══════════════════════════════════

  if (pathname === '/api/bets/create' && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in to create bets' });

    const body = await parseBody(req);
    const { title, category, icon, event_date, resolution_criteria, original_input, position } = body;

    if (!title) {
      return sendJSON(res, 400, { error: 'Bet title is required' });
    }

    const side = position === 'no' ? 'no' : 'yes';
    const newBet = {
      title,
      category: category || 'General',
      icon: icon || '🎲',
      event_date: event_date || '',
      resolution_criteria: resolution_criteria || '',
      original_input: original_input || title,
      created_by: user.DisplayName || user.Username || 'Anonymous',
      created_by_user_id: user.Id || user.id,
      yes_odds: side === 'yes' ? 55 : 45,
      no_odds: side === 'yes' ? 45 : 55,
      yes_count: side === 'yes' ? 1 : 0,
      no_count: side === 'no' ? 1 : 0,
      volume: 0,
      status: 'open',
      featured: false
    };

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('title', sql.NVarChar, newBet.title)
          .input('category', sql.NVarChar, newBet.category)
          .input('icon', sql.NVarChar, newBet.icon)
          .input('eventDate', sql.NVarChar, newBet.event_date)
          .input('resCriteria', sql.NVarChar, newBet.resolution_criteria)
          .input('originalInput', sql.NVarChar, newBet.original_input)
          .input('userId', sql.Int, newBet.created_by_user_id)
          .input('createdBy', sql.NVarChar, newBet.created_by)
          .input('yesOdds', sql.Int, newBet.yes_odds)
          .input('noOdds', sql.Int, newBet.no_odds)
          .input('yesCount', sql.Int, newBet.yes_count)
          .input('noCount', sql.Int, newBet.no_count)
          .query(`INSERT INTO B3tz_Bets (Title, Category, Icon, EventDate, ResolutionCriteria, OriginalInput, CreatedByUserId, CreatedByName, YesOdds, NoOdds, YesCount, NoCount)
                  OUTPUT INSERTED.Id
                  VALUES (@title, @category, @icon, @eventDate, @resCriteria, @originalInput, @userId, @createdBy, @yesOdds, @noOdds, @yesCount, @noCount)`);

        const betId = result.recordset[0].Id;
        // Also record the creator's initial bet position
        try {
          await dbPool.request()
            .input('userId', sql.Int, newBet.created_by_user_id)
            .input('betId', sql.Int, betId)
            .input('side', sql.NVarChar, side)
            .query('INSERT INTO B3tz_UserBets (UserId, BetId, Side) VALUES (@userId, @betId, @side)');
        } catch (ube) { /* ignore if fails */ }
        const apiBet = { id: betId, ...newBet };
        bets.unshift(apiBet);
        return sendJSON(res, 201, { bet: apiBet });
      } catch (e) {
        console.error('Create bet DB error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to create bet' });
      }
    } else {
      const apiBet = { id: bets.length + 100, ...newBet };
      bets.unshift(apiBet);
      return sendJSON(res, 201, { bet: apiBet });
    }
  }

  // ══════════════════════════════════
  // ── API: Arbitrate All Open Bets ──
  // ══════════════════════════════════

  if (pathname === '/api/ai/arbitrate' && req.method === 'POST') {
    // This can be called by a cron job or manually
    const body = await parseBody(req);
    const { secret } = body;

    // Simple secret to prevent random triggers (can be called from scheduled task)
    if (secret !== 'b3tz-arbitrate-2026' && secret !== 'manual') {
      // Also allow logged-in admin
      const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
      if (!user) return sendJSON(res, 401, { error: 'Unauthorized' });
    }

    const openBets = bets.filter(b => b.status === 'open');
    const results = [];

    for (const bet of openBets) {
      try {
        // Build a DB-compatible object for the arbitrator
        const dbBet = {
          Title: bet.title,
          ResolutionCriteria: bet.resolution_criteria,
          EventDate: bet.event_date,
          CreatedDate: bet.created_date || new Date().toISOString()
        };

        const verdict = await arbitrateBetWithAI(dbBet);

        if (verdict.status === 'resolved') {
          bet.status = 'resolved';
          bet.resolution = verdict.resolution;
          bet.resolution_reason = verdict.reason;

          // Update DB if available
          if (dbPool) {
            try {
              await dbPool.request()
                .input('id', sql.Int, bet.id)
                .input('status', sql.NVarChar, 'resolved')
                .input('resolution', sql.NVarChar, verdict.resolution)
                .input('reason', sql.NVarChar, verdict.reason)
                .query(`UPDATE B3tz_Bets SET Status = @status, Resolution = @resolution, ResolutionReason = @reason, ResolvedDate = GETUTCDATE() WHERE Id = @id`);
            } catch (e) {
              console.error('DB update error for bet', bet.id, e.message);
            }
          }

          results.push({ id: bet.id, title: bet.title, verdict: verdict.resolution, reason: verdict.reason });
        } else {
          results.push({ id: bet.id, title: bet.title, verdict: 'pending', reason: verdict.reason });
        }
      } catch (e) {
        console.error('Arbitration error for bet', bet.id, ':', e.message);
        results.push({ id: bet.id, title: bet.title, verdict: 'error', reason: e.message });
      }
    }

    return sendJSON(res, 200, { results, checked: openBets.length, timestamp: new Date().toISOString() });
  }

  // ── API: Arbitrate a single bet ──
  if (pathname === '/api/ai/arbitrate-one' && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });

    const body = await parseBody(req);
    const { betId } = body;
    const bet = bets.find(b => b.id === betId);

    if (!bet) return sendJSON(res, 404, { error: 'Bet not found' });
    if (bet.status !== 'open') return sendJSON(res, 400, { error: 'Bet is already resolved' });

    try {
      const dbBet = {
        Title: bet.title,
        ResolutionCriteria: bet.resolution_criteria,
        EventDate: bet.event_date,
        CreatedDate: bet.created_date || new Date().toISOString()
      };

      const verdict = await arbitrateBetWithAI(dbBet);
      return sendJSON(res, 200, { verdict });
    } catch (e) {
      console.error('Single arbitration error:', e.message);
      return sendJSON(res, 500, { error: 'Arbitration failed' });
    }
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

// ── Daily arbitration timer ──
function startArbitrationTimer() {
  // Run arbitration every 24 hours
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    console.log('[Arbitrator] Running daily bet arbitration...');
    const openBets = bets.filter(b => b.status === 'open');
    for (const bet of openBets) {
      try {
        const dbBet = {
          Title: bet.title,
          ResolutionCriteria: bet.resolution_criteria,
          EventDate: bet.event_date,
          CreatedDate: bet.created_date || new Date().toISOString()
        };
        const verdict = await arbitrateBetWithAI(dbBet);
        if (verdict.status === 'resolved') {
          bet.status = 'resolved';
          bet.resolution = verdict.resolution;
          bet.resolution_reason = verdict.reason;
          console.log(`[Arbitrator] Resolved: "${bet.title}" → ${verdict.resolution} (${verdict.reason})`);
          if (dbPool) {
            try {
              await dbPool.request()
                .input('id', sql.Int, bet.id)
                .input('status', sql.NVarChar, 'resolved')
                .input('resolution', sql.NVarChar, verdict.resolution)
                .input('reason', sql.NVarChar, verdict.reason)
                .query(`UPDATE B3tz_Bets SET Status = @status, Resolution = @resolution, ResolutionReason = @reason, ResolvedDate = GETUTCDATE() WHERE Id = @id`);
            } catch (e) { console.error('[Arbitrator] DB update failed:', e.message); }
          }
        }
      } catch (e) {
        console.error(`[Arbitrator] Error checking "${bet.title}":`, e.message);
      }
      // Rate limit: wait 2 seconds between bets to avoid hammering Claude API
      await new Promise(r => setTimeout(r, 2000));
    }
    console.log('[Arbitrator] Daily check complete.');
  }, TWENTY_FOUR_HOURS);

  console.log('[Arbitrator] Daily arbitration timer started (every 24h)');
}

// ── Start ──
initDB().then(async () => {
  await loadBetsFromDB();
  server.listen(PORT, () => {
    console.log(`B3tz running on port ${PORT}`);
    startArbitrationTimer();
  });
});
