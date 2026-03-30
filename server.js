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
  server: process.env.DB_SERVER || 'problems.database.windows.net',
  database: process.env.DB_NAME || '1000Problems',
  user: process.env.DB_USER || 'seahat',
  password: process.env.DB_PASSWORD || '5w2mf8v8A!',
  port: 1433,
  options: { encrypt: true, trustServerCertificate: false }
};

let sql; // will be loaded dynamically
let dbPool = null;

// ── Try to load mssql (installed via npm) ──
async function initDB(retries = 3) {
  sql = require('mssql');
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`DB connection attempt ${attempt}/${retries}...`);
      dbPool = await sql.connect({
        server: DB_CONFIG.server,
        database: DB_CONFIG.database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
        port: DB_CONFIG.port,
        options: DB_CONFIG.options,
        pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
        requestTimeout: 30000,
        connectionTimeout: 60000
      });
      console.log('Connected to Azure SQL');
      await ensureTables();
      return true;
    } catch (e) {
      console.log(`DB attempt ${attempt} failed: ${e.message}`);
      if (attempt < retries) {
        console.log('Waiting 15s before retry...');
        await new Promise(r => setTimeout(r, 15000));
        try { await sql.close(); } catch (_) {}
      }
    }
  }
  console.log('All DB attempts failed, running in memory mode');
  return false;
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

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'B3tz_PrivateBets')
    BEGIN
      CREATE TABLE B3tz_PrivateBets (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        ChallengerId INT NOT NULL,
        ChallengedId INT NOT NULL,
        Title NVARCHAR(300) NOT NULL,
        Icon NVARCHAR(10) DEFAULT '🔥',
        Category NVARCHAR(50) DEFAULT 'General',
        EventDate NVARCHAR(50),
        ResolutionCriteria NVARCHAR(2000),
        ChallengerSide NVARCHAR(3) NOT NULL,
        ChallengedSide NVARCHAR(3),
        Status NVARCHAR(20) DEFAULT 'pending',
        Resolution NVARCHAR(10),
        WinnerId INT,
        CreatedDate DATETIME2 DEFAULT GETUTCDATE(),
        AcceptedDate DATETIME2,
        ResolvedDate DATETIME2,
        FOREIGN KEY (ChallengerId) REFERENCES B3tz_Users(Id),
        FOREIGN KEY (ChallengedId) REFERENCES B3tz_Users(Id)
      );
      CREATE INDEX IX_B3tz_PrivateBets_Challenger ON B3tz_PrivateBets(ChallengerId);
      CREATE INDEX IX_B3tz_PrivateBets_Challenged ON B3tz_PrivateBets(ChallengedId);
    END
  `;
  try {
    await dbPool.request().query(query);
    console.log('B3tz tables ready (Users, Sessions, Bets, UserBets, Challenges, Rivals, PrivateBets)');
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
        SELECT u.Id, u.Username, u.Email, u.DisplayName, u.LastLoginDate
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

// Web search via DuckDuckGo HTML — returns actual search result snippets
function webSearch(query) {
  return new Promise((resolve) => {
    const encodedQuery = encodeURIComponent(query);
    const options = {
      hostname: 'html.duckduckgo.com',
      path: `/html/?q=${encodedQuery}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; if (data.length > 200000) res.destroy(); });
      res.on('end', () => {
        try {
          // Parse HTML results — extract titles and snippets
          const results = [];
          // Match result blocks: <a class="result__a" ...>TITLE</a> and <a class="result__snippet" ...>SNIPPET</a>
          const titleRegex = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
          const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

          const titles = [];
          const snippets = [];
          let m;
          while ((m = titleRegex.exec(data)) !== null) titles.push(m[1].replace(/<[^>]+>/g, '').trim());
          while ((m = snippetRegex.exec(data)) !== null) snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ').trim());

          for (let i = 0; i < Math.min(titles.length, snippets.length, 8); i++) {
            results.push({ title: titles[i], snippet: snippets[i] });
          }

          resolve({ results, raw: data.length });
        } catch (e) {
          resolve({ results: [], raw: 0 });
        }
      });
    });

    req.on('error', () => resolve({ results: [], raw: 0 }));
    req.setTimeout(12000, () => { req.destroy(); resolve({ results: [], raw: 0 }); });
    req.end();
  });
}

// Also keep the instant answer API as a supplementary source
function webSearchInstant(query) {
  return new Promise((resolve) => {
    const encodedQuery = encodeURIComponent(query);
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
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ Abstract: '', Results: [] }); }
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
// ── Server-side profanity pre-filter ──
// Catches obvious profanity/slurs BEFORE calling the AI, saving API costs
const BLOCKED_PATTERNS = [
  // Common profanity
  /\b(fuck|f[*]?uck|fuk|fuq|fck|stfu|gtfo|wtf)\b/i,
  /\b(shit|sh[*1!]t|bullshit|horseshit)\b/i,
  /\b(ass|a[*]?ss|assh[o0]le|dumb[a@]ss)\b/i,
  /\b(bitch|b[*1!]tch|biatch)\b/i,
  /\b(damn|d[a@]mn)\b/i,
  /\b(dick|d[*1!]ck|c[o0]ck|penis|peen)\b/i,
  /\b(pussy|p[*]?ussy|cunt|c[*]?unt|vag)\b/i,
  /\b(whore|wh[o0]re|slut|sl[*]?ut|hoe|thot)\b/i,
  /\b(bastard|b[a@]stard)\b/i,
  // Slurs / hate speech (covering common variants)
  /\b(nigg|n[1!]gg|niga|negro|sp[i1!]c|ch[i1!]nk|k[i1!]ke|f[a@]g|f[a@]gg[o0]t|d[y1]ke|tr[a@]nn[y1!]|retard)\b/i,
  // Sexual / adult content
  /\b(porn|p[o0]rn|xxx|hentai|nude|naked|blowjob|handjob|orgasm|orgies|orgy|dildo|vibrator|masturbat|ejaculat|anal\s?sex|oral\s?sex)\b/i,
  // Violence / harm
  /\b(rape|r[a@]pe|molest|pedoph|murder|kill\s+(myself|himself|herself|someone)|suicide\s+bet|school\s+shoot|mass\s+shoot|bomb\s+threat)\b/i,
  // Drug abuse (encouraging illegal use)
  /\b(meth|heroin|crack\s?cocaine|fentanyl|overdose)\b/i,
  // Leet speak / unicode evasion patterns
  /\b(f[\W_]*u[\W_]*c[\W_]*k)\b/i,
  /\b(s[\W_]*h[\W_]*[i1!][\W_]*t)\b/i,
];

function preFilterBetInput(input) {
  const cleaned = input.replace(/[_\-.*]/g, ''); // strip common obfuscation chars
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(input) || pattern.test(cleaned)) {
      return { blocked: true, reason: 'Your bet contains language that isn\'t allowed on B3tz. This is a family-friendly platform — keep it clean and try again!' };
    }
  }
  // Also block very short or obviously empty inputs
  if (input.replace(/[^a-zA-Z]/g, '').length < 5) {
    return { blocked: true, reason: 'Please provide a more descriptive bet.' };
  }
  return { blocked: false };
}

async function validateBetWithAI(userInput) {
  // Pre-filter before calling AI
  const preCheck = preFilterBetInput(userInput);
  if (preCheck.blocked) {
    return { status: 'invalid', reason: preCheck.reason };
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentTime = now.toISOString();
  const etTime = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
  const ctTime = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
  const mtTime = now.toLocaleString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', hour12: true });
  const ptTime = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });

  const systemPrompt = `You are the B3tz bet validator. Your job is to take a user's natural language bet and turn it into a structured, verifiable bet.

Today's date: ${today}
Current UTC time: ${currentTime}
Current US times: Eastern: ${etTime} | Central: ${ctTime} | Mountain: ${mtTime} | Pacific: ${ptTime}

CONTENT POLICY (HIGHEST PRIORITY — enforce before anything else):
This is a FAMILY-FRIENDLY platform. You MUST reject any bet that contains or implies:
- Profanity, slurs, or vulgar language (including masked with symbols like f*ck, sh!t, etc.)
- Sexual or adult content of any kind
- Violence, self-harm, or threats against real people
- Hate speech, discrimination, or targeting of individuals/groups
- Drug abuse or illegal activity encouragement
- Bullying, harassment, or humiliation of real named private individuals
- Bets designed to be cruel, degrading, or harmful to anyone
- Anything a responsible parent wouldn't want their teenager to see

If the bet violates content policy, respond:
{"status":"invalid","reason":"This bet isn't appropriate for B3tz. We're a family-friendly platform — please keep bets fun, clean, and respectful!"}

Be vigilant about EVASION TRICKS:
- Misspellings, leet speak (sh1t, phuck, etc.), spaced-out words (f u c k), unicode substitution
- Bets that seem innocent on the surface but are clearly coded references to inappropriate content
- Bets where the title is clean but the implied meaning is vulgar or harmful
- "Will [celebrity] die" type bets — these are inappropriate even if technically verifiable

EVENT TIMING RULES (CRITICAL — READ CAREFULLY):
Same-day bets are the #1 most common bet type. You MUST allow them unless you have DEFINITIVE proof the event is over.

GOLDEN RULE: If you do not know the EXACT, SPECIFIC start time of THIS PARTICULAR event, you MUST ALLOW the bet. Do NOT guess. Do NOT assume. Sports leagues have games at MANY different times throughout the day — for example, NCAA March Madness has games from 12 PM ET through 10 PM ET. You cannot assume "it's afternoon so the game started." There could be an evening game.

ALLOW the bet if:
- The event is tomorrow or later
- The event is today and you do NOT know for certain that THIS SPECIFIC event has already ENDED with a publicly known outcome
- You only know approximate/general game times but not the specific time for THIS game → ALLOW
- The event has no specific start time (like "Bitcoin hits $200K") and the outcome isn't already known

REJECT the bet ONLY if:
- You know the SPECIFIC start time of THIS event AND the current time is after that start time
- You are certain the event ALREADY ENDED and the final outcome is publicly known
- The event happened on a previous day and the outcome is known

CRITICAL: Do NOT reject based on general assumptions like "NCAA games are usually in the afternoon." Many games are in the evening. If you're not sure, ALLOW.

Rules for VALID bets:
1. The bet MUST be about an event with an objectively verifiable yes/no outcome.
2. Reject bets about subjective opinions ("pizza is the best food") — these can't be resolved.
3. Reject bets about events that have ALREADY HAPPENED and whose outcome is known.
4. If the event date is uncertain or could change (e.g. elections, product launches), note that in the resolution criteria. Use language like "when the event occurs" rather than locking to a specific date.
5. Provide a clear title (concise, max 80 chars), a category, an icon emoji, an estimated event date, and detailed resolution criteria.
6. The resolution criteria should describe EXACTLY how this bet will be resolved — what constitutes a YES and what constitutes a NO. Be specific enough that anyone could verify it.
7. If the bet is ambiguous, ask a clarifying question instead of guessing.

Respond with ONLY a JSON object (no markdown, no code fences) in one of these formats:

If VALID bet:
{"status":"valid","title":"...","category":"...","icon":"...","event_date":"YYYY-MM-DD","resolution_criteria":"...","needs_clarification":false}

If NEEDS CLARIFICATION:
{"status":"clarify","question":"...","suggestions":["option1","option2"]}

If INVALID (content policy violation, subjective, already happened, in progress, nonsensical):
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

// ── Check if an existing bet's event is still valid to bet on (hasn't started/ended) ──
async function checkBetTimingWithAI(bet) {
  const now = new Date();
  const currentTime = now.toISOString();
  const etTime = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
  const ctTime = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
  const mtTime = now.toLocaleString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', hour12: true });
  const ptTime = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });

  // Quick check: if event_date is well in the future (>1 day away), skip AI call
  if (bet.event_date) {
    const eventDate = new Date(bet.event_date + 'T23:59:59Z');
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    if (eventDate > tomorrow) {
      return { allowed: true }; // Event is more than a day away, no need for AI check
    }
  }

  // For same-day or past-date events, ask AI to check timing
  const systemPrompt = `You are a quick event timing checker for B3tz betting platform.

Current UTC time: ${currentTime}
Current US times: Eastern: ${etTime} | Central: ${ctTime} | Mountain: ${mtTime} | Pacific: ${ptTime}

Given the bet title and event date below, determine if someone should still be allowed to place a bet.

GOLDEN RULE: If you do NOT know the EXACT, SPECIFIC start time of THIS PARTICULAR event, respond {"allowed":true}. Do NOT guess. Sports have games at many different times throughout the day.

Rules:
- ALLOW if the event is today and you do NOT know for certain it has already ENDED with a known outcome
- ALLOW if you only know general/approximate game times but not this specific game's time
- REJECT ONLY if you are certain the event ALREADY ENDED and the final outcome is publicly known
- REJECT if the event happened on a previous day and the outcome is known
- For open-ended bets with no specific start time (like "Bitcoin hits $200K"), always allow.
- Do NOT reject based on general assumptions like "games usually start in the afternoon"

Respond with ONLY a JSON object: {"allowed":true} or {"allowed":false,"reason":"..."}
No markdown.`;

  try {
    const response = await callClaudeAPI(
      [{ role: 'user', content: `Bet title: "${bet.title}"\nEvent date: ${bet.event_date || 'not specified'}\nResolution criteria: ${bet.resolution_criteria || 'none'}` }],
      systemPrompt
    );
    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('Bet timing check error:', err.message);
    // On error, allow the bet (benefit of the doubt)
    return { allowed: true };
  }
}

// ── Arbitrate a bet using Claude + web search ──
async function arbitrateBetWithAI(bet) {
  const today = new Date().toISOString().split('T')[0];

  // Step 1: Do web research with MULTIPLE search strategies
  // Generate good search queries — include score/result terms for sports
  const searchQueries = [
    bet.Title + ' result score',
    bet.Title + ' winner outcome today',
    bet.Title + ' final score ' + today,
  ];

  let searchResults = '';

  // DDG HTML search — gets real web results with snippets
  for (const query of searchQueries) {
    try {
      const ddg = await webSearch(query);
      if (ddg.results && ddg.results.length > 0) {
        searchResults += `\n=== Search: "${query}" ===\n`;
        ddg.results.forEach((r, i) => {
          searchResults += `${i + 1}. ${r.title}\n   ${r.snippet}\n`;
        });
      }
    } catch (e) {
      console.error('Search error:', e.message);
    }
  }

  // Also try DDG instant answer as supplement
  try {
    const instant = await webSearchInstant(bet.Title + ' result');
    if (instant.Abstract) searchResults += `\nInstant Answer: ${instant.Abstract}\n`;
    if (instant.Answer) searchResults += `Direct Answer: ${instant.Answer}\n`;
  } catch (e) { /* ignore */ }

  console.log(`[Arbitrator] Search for "${bet.Title}" found ${searchResults.length} chars of results`);

  // Step 2: Ask Claude to arbitrate based on research
  const systemPrompt = `You are the B3tz bet arbitrator. Your job: determine if a bet's outcome is NOW KNOWN.

Today's date: ${today}

Bet details:
- Title: ${bet.Title}
- Resolution Criteria: ${bet.ResolutionCriteria || 'Resolves YES if the stated event occurs, NO otherwise.'}
- Event Date: ${bet.EventDate || 'Not specified'}
- Created: ${bet.CreatedDate}

Web search results:
${searchResults || 'No relevant search results found.'}

IMPORTANT INSTRUCTIONS:
1. Carefully read ALL search result snippets. Look for final scores, game outcomes, official results, news reports confirming an event happened or didn't happen.
2. Sports games: Look for final scores, box scores, post-game reports. If multiple snippets confirm a game result, that's strong evidence.
3. If the event date has PASSED and search results discuss the outcome, you should resolve the bet.
4. Only say "pending" if the event genuinely hasn't happened yet or there's real ambiguity about the outcome.
5. Do NOT default to "pending" just because the search results aren't perfectly clean — use all available evidence.

Respond with ONLY a JSON object (no markdown, no code fences):

If still pending: {"status":"pending","reason":"Brief explanation"}
If resolved: {"status":"resolved","resolution":"yes" or "no","reason":"Clear explanation with evidence from search results"}`;

  const response = await callClaudeAPI(
    [{ role: 'user', content: `Arbitrate this bet now. Analyze all search results carefully for evidence of the outcome.` }],
    systemPrompt
  );

  const text = response.content[0].text.trim();
  const jsonStr = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(jsonStr);
}

// ══════════════════════════════
// ── In-memory bet store (seed data) ──
// ══════════════════════════════

// seahat's picks: side chosen based on likely outcome analysis
const seedBets = [
  { id: 1, title: "Russell will win Miami Grand Prix", category: "F1", event_date: "2026-05-03", created_by: "seahat", creator_side: "no", yes_count: 0, no_count: 1, volume: 1, status: "open", icon: "🏎️", featured: true, resolution_criteria: "Resolves YES if George Russell is declared the official winner of the 2026 Miami Grand Prix. Resolves NO otherwise. If the race is postponed, resolution follows the rescheduled date." },
  { id: 2, title: "Spain wins 2026 FIFA World Cup", category: "Soccer", event_date: "2026-07-19", created_by: "seahat", creator_side: "yes", yes_count: 1, no_count: 0, volume: 1, status: "open", icon: "⚽", featured: true, resolution_criteria: "Resolves YES if Spain's national football team wins the 2026 FIFA World Cup Final. Resolves NO otherwise." },
  { id: 3, title: "Bitcoin hits $200K before 2027", category: "Crypto", event_date: "2026-12-31", created_by: "seahat", creator_side: "yes", yes_count: 1, no_count: 0, volume: 1, status: "open", icon: "₿", featured: true, resolution_criteria: "Resolves YES if Bitcoin (BTC) reaches a price of $200,000 USD or higher on any major exchange before January 1, 2027. Resolves NO if it does not reach this price by that date." },
  { id: 4, title: "AI passes bar exam with 99th percentile", category: "Tech", event_date: "2026-12-31", created_by: "seahat", creator_side: "yes", yes_count: 1, no_count: 0, volume: 1, status: "open", icon: "🤖", resolution_criteria: "Resolves YES if any AI system publicly achieves a 99th percentile score on the Uniform Bar Examination by end of 2026." },
  { id: 5, title: "Lakers make NBA Finals 2026", category: "Basketball", event_date: "2026-06-15", created_by: "seahat", creator_side: "no", yes_count: 0, no_count: 1, volume: 1, status: "open", icon: "🏀", resolution_criteria: "Resolves YES if the Los Angeles Lakers reach the 2026 NBA Finals. Resolves NO if eliminated before the Finals." },
  { id: 6, title: "Tesla releases sub-$25K vehicle in 2026", category: "Tech", event_date: "2026-12-31", created_by: "seahat", creator_side: "no", yes_count: 0, no_count: 1, volume: 1, status: "open", icon: "🚗", resolution_criteria: "Resolves YES if Tesla begins sales or deliveries of a vehicle with a base MSRP under $25,000 USD during 2026." },
  { id: 7, title: "Ohtani hits 50+ HRs again in 2026", category: "Baseball", event_date: "2026-10-01", created_by: "seahat", creator_side: "no", yes_count: 0, no_count: 1, volume: 1, status: "open", icon: "⚾", resolution_criteria: "Resolves YES if Shohei Ohtani hits 50 or more home runs in the 2026 MLB regular season." },
  { id: 8, title: "Ethereum flips Bitcoin market cap", category: "Crypto", event_date: "2026-12-31", created_by: "seahat", creator_side: "no", yes_count: 0, no_count: 1, volume: 1, status: "open", icon: "⟠", resolution_criteria: "Resolves YES if Ethereum's total market capitalization exceeds Bitcoin's at any point during 2026 on CoinMarketCap or CoinGecko." },
  { id: 9, title: "US lands astronauts on Moon in 2026", category: "Science", event_date: "2026-12-31", created_by: "seahat", creator_side: "no", yes_count: 0, no_count: 1, volume: 1, status: "open", icon: "🌙", resolution_criteria: "Resolves YES if NASA's Artemis program successfully lands astronauts on the lunar surface during 2026. Resolves NO if the mission is delayed beyond 2026." },
  { id: 10, title: "Next GTA breaks day-one sales record", category: "Gaming", event_date: "2026-12-31", created_by: "seahat", creator_side: "yes", yes_count: 1, no_count: 0, volume: 1, status: "open", icon: "🎮", resolution_criteria: "Resolves YES if Grand Theft Auto VI breaks the existing record for day-one video game sales when it launches." },
  { id: 11, title: "Verstappen wins F1 Championship 2026", category: "F1", event_date: "2026-12-15", created_by: "seahat", creator_side: "yes", yes_count: 1, no_count: 0, volume: 1, status: "open", icon: "🏎️", resolution_criteria: "Resolves YES if Max Verstappen wins the 2026 FIA Formula One World Drivers' Championship." },
  { id: 12, title: "Drake drops album before summer 2026", category: "Music", event_date: "2026-06-21", created_by: "seahat", creator_side: "yes", yes_count: 1, no_count: 0, volume: 1, status: "open", icon: "🎵", resolution_criteria: "Resolves YES if Drake releases a new studio album before June 21, 2026 (first day of summer). Singles and EPs do not count." }
];

// Compute real odds from counts
seedBets.forEach(b => {
  const total = b.yes_count + b.no_count;
  b.yes_odds = total > 0 ? Math.round((b.yes_count / total) * 100) : 50;
  b.no_odds = 100 - b.yes_odds;
});

// In-memory bets (used if DB not available, or as cache)
let bets = [...seedBets];

// Ensure seahat user exists and return its ID
async function ensureSeahatUser() {
  if (!dbPool) return null;
  try {
    const existing = await dbPool.request()
      .input('username', sql.NVarChar, 'seahat')
      .query('SELECT Id FROM B3tz_Users WHERE Username = @username');
    if (existing.recordset.length > 0) {
      console.log('seahat user exists, skipping password reset');
      return existing.recordset[0].Id;
    }

    // Create seahat user with known password
    const { hash, salt } = hashPassword('cuervo');
    const result = await dbPool.request()
      .input('username', sql.NVarChar, 'seahat')
      .input('email', sql.NVarChar, 'seahat@b3tz.local')
      .input('hash', sql.NVarChar, hash)
      .input('salt', sql.NVarChar, salt)
      .input('display', sql.NVarChar, 'seahat')
      .query(`INSERT INTO B3tz_Users (Username, Email, PasswordHash, PasswordSalt, DisplayName)
              OUTPUT INSERTED.Id VALUES (@username, @email, @hash, @salt, @display)`);
    console.log('Created seahat user');
    return result.recordset[0].Id;
  } catch (e) {
    console.error('Error creating seahat user:', e.message);
    return null;
  }
}

// Load bets from DB on startup (if available)
async function loadBetsFromDB() {
  if (!dbPool) return;
  try {
    const result = await dbPool.request().query('SELECT * FROM B3tz_Bets ORDER BY CreatedDate DESC');
    if (result.recordset.length === 0) {
      // Ensure seahat user exists
      const seahatId = await ensureSeahatUser();

      // Seed DB with initial bets
      for (const bet of seedBets) {
        const insertResult = await dbPool.request()
          .input('title', sql.NVarChar, bet.title)
          .input('category', sql.NVarChar, bet.category)
          .input('icon', sql.NVarChar, bet.icon)
          .input('eventDate', sql.NVarChar, bet.event_date)
          .input('resCriteria', sql.NVarChar, bet.resolution_criteria)
          .input('createdBy', sql.NVarChar, bet.created_by)
          .input('createdByUserId', sql.Int, seahatId)
          .input('yesOdds', sql.Int, bet.yes_odds)
          .input('noOdds', sql.Int, bet.no_odds)
          .input('yesCount', sql.Int, bet.yes_count)
          .input('noCount', sql.Int, bet.no_count)
          .input('volume', sql.Int, bet.volume)
          .input('featured', sql.Bit, bet.featured ? 1 : 0)
          .query(`INSERT INTO B3tz_Bets (Title, Category, Icon, EventDate, ResolutionCriteria, CreatedByName, CreatedByUserId, YesOdds, NoOdds, YesCount, NoCount, Volume, Featured)
                  OUTPUT INSERTED.Id
                  VALUES (@title, @category, @icon, @eventDate, @resCriteria, @createdBy, @createdByUserId, @yesOdds, @noOdds, @yesCount, @noCount, @volume, @featured)`);

        // Create seahat's bet entry
        if (seahatId && bet.creator_side) {
          const betDbId = insertResult.recordset[0].Id;
          await dbPool.request()
            .input('userId', sql.Int, seahatId)
            .input('betId', sql.Int, betDbId)
            .input('side', sql.NVarChar, bet.creator_side)
            .query('INSERT INTO B3tz_UserBets (UserId, BetId, Side) VALUES (@userId, @betId, @side)');
        }
      }
      console.log('Seeded B3tz_Bets with initial data (owned by seahat)');
      // Reload
      const r2 = await dbPool.request().query('SELECT * FROM B3tz_Bets ORDER BY CreatedDate DESC');
      bets = r2.recordset.map(dbBetToApi);
    } else {
      bets = result.recordset.map(dbBetToApi);

      // Migration: assign old seed bets to seahat if they have fake creator names
      const seahatId = await ensureSeahatUser();
      if (seahatId) {
        const fakeNames = ['Angel', 'Carlos', 'Satoshi42', 'TechWatcher', 'LakeShow', 'EVFanatic', 'DiamondDog', 'DeFiMax', 'SpaceNerd', 'PixelKing', 'PitLane', '6ixGod'];
        for (const bet of bets) {
          if (fakeNames.includes(bet.created_by) && !bet.created_by_user_id) {
            // Update to seahat ownership
            await dbPool.request()
              .input('id', sql.Int, bet.id)
              .input('name', sql.NVarChar, 'seahat')
              .input('userId', sql.Int, seahatId)
              .query('UPDATE B3tz_Bets SET CreatedByName = @name, CreatedByUserId = @userId WHERE Id = @id');
            bet.created_by = 'seahat';
            bet.created_by_user_id = seahatId;

            // Find matching seed bet for the creator's side pick
            const seedBet = seedBets.find(sb => sb.title === bet.title);
            if (seedBet && seedBet.creator_side) {
              // Recalculate: count actual UserBets for this bet
              const ubResult = await dbPool.request()
                .input('betId', sql.Int, bet.id)
                .query('SELECT Side, COUNT(*) as cnt FROM B3tz_UserBets WHERE BetId = @betId GROUP BY Side');
              let yc = 0, nc = 0;
              for (const r of ubResult.recordset) {
                if (r.Side === 'yes') yc = r.cnt;
                if (r.Side === 'no') nc = r.cnt;
              }

              // If seahat hasn't bet yet, create the bet entry
              const existingBet = await dbPool.request()
                .input('userId', sql.Int, seahatId)
                .input('betId', sql.Int, bet.id)
                .query('SELECT Id FROM B3tz_UserBets WHERE UserId = @userId AND BetId = @betId');
              if (existingBet.recordset.length === 0) {
                await dbPool.request()
                  .input('userId', sql.Int, seahatId)
                  .input('betId', sql.Int, bet.id)
                  .input('side', sql.NVarChar, seedBet.creator_side)
                  .query('INSERT INTO B3tz_UserBets (UserId, BetId, Side) VALUES (@userId, @betId, @side)');
                if (seedBet.creator_side === 'yes') yc++; else nc++;
              }

              // Recalculate odds from actual counts
              const total = yc + nc;
              const yo = total > 0 ? Math.round((yc / total) * 100) : 50;
              const no_ = 100 - yo;
              await dbPool.request()
                .input('id', sql.Int, bet.id)
                .input('yc', sql.Int, yc).input('nc', sql.Int, nc)
                .input('yo', sql.Int, yo).input('no', sql.Int, no_)
                .input('vol', sql.Int, total)
                .query('UPDATE B3tz_Bets SET YesCount = @yc, NoCount = @nc, YesOdds = @yo, NoOdds = @no, Volume = @vol WHERE Id = @id');
              bet.yes_count = yc; bet.no_count = nc;
              bet.yes_odds = yo; bet.no_odds = no_;
              bet.volume = total;
            }
          }
        }
        console.log('Migrated seed bets to seahat ownership with real odds');
      }

      // Migration: recalculate ALL bet odds from actual UserBets counts
      console.log('Recalculating odds for all bets from actual vote counts...');
      for (const bet of bets) {
        try {
          const ubResult = await dbPool.request()
            .input('betId', sql.Int, bet.id)
            .query('SELECT Side, COUNT(*) as cnt FROM B3tz_UserBets WHERE BetId = @betId GROUP BY Side');
          let yc = 0, nc = 0;
          for (const r of ubResult.recordset) {
            if (r.Side === 'yes') yc = r.cnt;
            if (r.Side === 'no') nc = r.cnt;
          }
          const total = yc + nc;
          const yo = total > 0 ? Math.round((yc / total) * 100) : 50;
          const no_ = 100 - yo;
          if (bet.yes_odds !== yo || bet.no_odds !== no_ || bet.yes_count !== yc || bet.no_count !== nc) {
            await dbPool.request()
              .input('id', sql.Int, bet.id)
              .input('yc', sql.Int, yc).input('nc', sql.Int, nc)
              .input('yo', sql.Int, yo).input('no', sql.Int, no_)
              .query('UPDATE B3tz_Bets SET YesCount = @yc, NoCount = @nc, YesOdds = @yo, NoOdds = @no WHERE Id = @id');
            bet.yes_count = yc; bet.no_count = nc;
            bet.yes_odds = yo; bet.no_odds = no_;
          }
        } catch (mErr) { console.error('Odds migration error for bet', bet.id, mErr.message); }
      }
      console.log('Odds recalculation complete');

      // Migration: ensure every bet has its creator as a player in B3tz_UserBets
      console.log('Checking for bets missing creator entries...');
      for (const bet of bets) {
        if (!bet.created_by_user_id) continue;
        try {
          const existing = await dbPool.request()
            .input('userId', sql.Int, bet.created_by_user_id)
            .input('betId', sql.Int, bet.id)
            .query('SELECT Id FROM B3tz_UserBets WHERE UserId = @userId AND BetId = @betId');
          if (existing.recordset.length === 0) {
            // Creator has no bet entry — add them as 'yes' by default
            const defaultSide = 'yes';
            await dbPool.request()
              .input('userId', sql.Int, bet.created_by_user_id)
              .input('betId', sql.Int, bet.id)
              .input('side', sql.NVarChar, defaultSide)
              .query('INSERT INTO B3tz_UserBets (UserId, BetId, Side) VALUES (@userId, @betId, @side)');
            // Update bet counts and odds
            bet.yes_count++;
            const total = bet.yes_count + bet.no_count;
            bet.yes_odds = Math.round((bet.yes_count / total) * 100);
            bet.no_odds = 100 - bet.yes_odds;
            await dbPool.request()
              .input('id', sql.Int, bet.id)
              .input('yc', sql.Int, bet.yes_count).input('nc', sql.Int, bet.no_count)
              .input('yo', sql.Int, bet.yes_odds).input('no', sql.Int, bet.no_odds)
              .query('UPDATE B3tz_Bets SET YesCount = @yc, NoCount = @nc, YesOdds = @yo, NoOdds = @no WHERE Id = @id');
            console.log(`  Added creator ${bet.created_by} as 'yes' player on bet ${bet.id}: "${bet.title}"`);
          }
        } catch (mErr) { console.error('Creator backfill error for bet', bet.id, mErr.message); }
      }
      console.log('Creator backfill complete');
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
          .query('SELECT Id, Username, Email, DisplayName, PasswordHash, PasswordSalt, LastLoginDate FROM B3tz_Users WHERE Username = @login OR Email = @login');

        const user = result.recordset[0];
        if (!user) {
          return sendJSON(res, 401, { error: 'Invalid username or password' });
        }

        // If password doesn't match, set it as their new password (post-reset flow)
        if (!verifyPassword(password, user.PasswordHash, user.PasswordSalt)) {
          const { hash: newHash, salt: newSalt } = hashPassword(password);
          await dbPool.request()
            .input('id', sql.Int, user.Id)
            .input('hash', sql.NVarChar, newHash)
            .input('salt', sql.NVarChar, newSalt)
            .query('UPDATE B3tz_Users SET PasswordHash = @hash, PasswordSalt = @salt WHERE Id = @id');
          console.log(`Password reset-on-login for user: ${user.Username}`);
        }

        const previousLogin = user.LastLoginDate;

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
          user: { id: user.Id, username: user.Username, email: user.Email, displayName: user.DisplayName, lastLoginDate: previousLogin }
        }, { 'Set-Cookie': setCookie('b3tz_session', token, 30*24*3600) });

      } catch (e) {
        console.error('Login error:', e.message);
        return sendJSON(res, 500, { error: 'Server error during login' });
      }
    } else {
      const user = memoryUsers.find(u => u.username === login || u.email === login);
      if (!user) {
        return sendJSON(res, 401, { error: 'Invalid username or password' });
      }
      if (!verifyPassword(password, user.hash, user.salt)) {
        const { hash: newHash, salt: newSalt } = hashPassword(password);
        user.hash = newHash;
        user.salt = newSalt;
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
    // Normalize to camelCase (DB returns PascalCase)
    const normalized = {
      id: user.Id || user.id,
      username: user.Username || user.username,
      email: user.Email || user.email,
      displayName: user.DisplayName || user.displayName || user.Username || user.username,
      lastLoginDate: user.LastLoginDate || user.lastLoginDate || null
    };
    return sendJSON(res, 200, { user: normalized });
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

  // ── API: Bets (supports pagination) ──
  if (pathname === '/api/bets' && req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const page = parseInt(url.searchParams.get('page')) || 0;
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 0, 200);
    if (page > 0 && limit > 0) {
      const start = (page - 1) * limit;
      const slice = bets.slice(start, start + limit);
      return sendJSON(res, 200, { bets: slice, total: bets.length, page, limit, hasMore: start + limit < bets.length });
    }
    // Default: return all (backward-compatible)
    return sendJSON(res, 200, { bets });
  }

  // ── API: Single bet detail ──
  if (pathname.startsWith('/api/bets/detail/') && req.method === 'GET') {
    const betId = parseInt(pathname.split('/').pop());
    const bet = bets.find(b => b.id === betId);
    if (!bet) return sendJSON(res, 404, { error: 'Bet not found' });
    return sendJSON(res, 200, { bet });
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

    // Check if event has already started or ended (AI timing check)
    try {
      const timingCheck = await checkBetTimingWithAI(bet);
      if (!timingCheck.allowed) {
        return sendJSON(res, 400, { error: timingCheck.reason || 'This event has already started or ended. Betting is closed.' });
      }
    } catch (timingErr) {
      console.error('Timing check error (allowing bet):', timingErr.message);
      // On error, allow the bet — benefit of the doubt
    }

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
                // Only create rivalry if they picked OPPOSITE sides
                const senderBet = await dbPool.request()
                  .input('senderId', sql.Int, ch.SenderUserId)
                  .input('betId', sql.Int, betId)
                  .query('SELECT Side FROM B3tz_UserBets WHERE UserId = @senderId AND BetId = @betId');
                const senderSide = senderBet.recordset.length > 0 ? senderBet.recordset[0].Side : null;
                if (senderSide && senderSide !== betSide) {
                  // Opposite sides → create mutual rival entries (both directions)
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
  // ── API: Debug user bets (temporary) ──
  // ══════════════════════════════════
  const debugMatch = pathname.match(/^\/api\/debug\/user-bets\/(.+)$/);
  if (debugMatch && req.method === 'GET') {
    const username = decodeURIComponent(debugMatch[1]);
    if (dbPool) {
      try {
        const userResult = await dbPool.request()
          .input('username', sql.NVarChar, username)
          .query('SELECT Id, Username, DisplayName FROM B3tz_Users WHERE Username = @username');
        if (userResult.recordset.length === 0) return sendJSON(res, 404, { error: 'User not found' });
        const uid = userResult.recordset[0].Id;
        const betsResult = await dbPool.request()
          .input('userId', sql.Int, uid)
          .query(`SELECT ub.Id AS UbId, ub.BetId, ub.Side, ub.PlacedDate, b.Title, b.Category
                  FROM B3tz_UserBets ub JOIN B3tz_Bets b ON b.Id = ub.BetId
                  WHERE ub.UserId = @userId ORDER BY ub.PlacedDate DESC`);
        return sendJSON(res, 200, { user: userResult.recordset[0], bets: betsResult.recordset, total: betsResult.recordset.length });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    return sendJSON(res, 200, { error: 'No DB' });
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
  // ── API: Enriched Players for a Bet ──
  // ══════════════════════════════════════
  const playersMatch = pathname.match(/^\/api\/bets\/(\d+)\/players$/);
  if (playersMatch && req.method === 'GET') {
    const betId = parseInt(playersMatch[1]);
    const user = dbPool ? await getUserFromSession(req) : null;
    const userId = user ? (user.Id || user.id) : null;

    if (dbPool) {
      try {
        // Get all voters on this bet
        const votersResult = await dbPool.request()
          .input('betId', sql.Int, betId)
          .query(`
            SELECT u.Id, u.Username, u.DisplayName, ub.Side, ub.PlacedDate
            FROM B3tz_UserBets ub
            JOIN B3tz_Users u ON u.Id = ub.UserId
            WHERE ub.BetId = @betId
            ORDER BY ub.PlacedDate ASC
          `);

        if (!userId) {
          // Not logged in — return basic player data
          const players = votersResult.recordset.map(r => ({
            id: r.Id, username: r.Username,
            displayName: r.DisplayName || r.Username,
            side: r.Side, relationship: 'none',
            sharedBets: 0, opposingPicks: 0, sameSidePicks: 0
          }));
          return sendJSON(res, 200, { players });
        }

        // Get rival/nemesis relationships for current user
        const rivalResult = await dbPool.request()
          .input('userId', sql.Int, userId)
          .query(`
            SELECT r.RivalUserId,
                   CASE WHEN r2.Id IS NOT NULL THEN 'nemesis' ELSE 'rival' END AS relationship
            FROM B3tz_Rivals r
            LEFT JOIN B3tz_Rivals r2 ON r2.UserId = r.RivalUserId AND r2.RivalUserId = r.UserId
            WHERE r.UserId = @userId
          `);
        const relMap = {};
        rivalResult.recordset.forEach(r => { relMap[r.RivalUserId] = r.relationship; });

        // Get shared bet stats for each voter vs current user
        const otherIds = votersResult.recordset.map(r => r.Id).filter(id => id !== userId);
        let statsMap = {};
        if (otherIds.length > 0) {
          const idList = otherIds.join(',');
          const statsResult = await dbPool.request()
            .input('userId', sql.Int, userId)
            .query(`
              SELECT
                other.UserId AS OtherId,
                COUNT(*) AS SharedBets,
                SUM(CASE WHEN other.Side <> mine.Side THEN 1 ELSE 0 END) AS Opposing,
                SUM(CASE WHEN other.Side = mine.Side THEN 1 ELSE 0 END) AS SameSide
              FROM B3tz_UserBets mine
              JOIN B3tz_UserBets other ON other.BetId = mine.BetId AND other.UserId <> mine.UserId
              WHERE mine.UserId = @userId AND other.UserId IN (${idList})
              GROUP BY other.UserId
            `);
          statsResult.recordset.forEach(r => {
            statsMap[r.OtherId] = { shared: r.SharedBets, opposing: r.Opposing, sameSide: r.SameSide };
          });
        }

        // Build enriched player list
        const players = votersResult.recordset.map(r => {
          const stats = statsMap[r.Id] || { shared: 0, opposing: 0, sameSide: 0 };
          const isMe = r.Id === userId;
          return {
            id: r.Id,
            username: r.Username,
            displayName: r.DisplayName || r.Username,
            side: r.Side,
            isMe,
            relationship: isMe ? 'you' : (relMap[r.Id] || 'none'),
            sharedBets: stats.shared,
            opposingPicks: stats.opposing,
            sameSidePicks: stats.sameSide,
            heatScore: stats.shared > 0 ? Math.round((stats.opposing / stats.shared) * 100) : 0
          };
        });

        // Sort: you first, then nemesis, then rival, then by heat score desc
        const tierOrder = { you: 0, nemesis: 1, rival: 2, none: 3 };
        players.sort((a, b) => {
          const ta = tierOrder[a.relationship] ?? 3;
          const tb = tierOrder[b.relationship] ?? 3;
          if (ta !== tb) return ta - tb;
          return b.heatScore - a.heatScore;
        });

        return sendJSON(res, 200, { players });
      } catch (e) {
        console.error('Enriched players error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to load players' });
      }
    } else {
      return sendJSON(res, 200, { players: [] });
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
  <meta http-equiv="refresh" content="2;url=${redirectUrl}">
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

  // ══════════════════════════════════════
  // ── API: Get My Rivals ──
  // ══════════════════════════════════════

  if (pathname === '/api/rivals' && req.method === 'GET') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('userId', sql.Int, userId)
          .query(`
            SELECT r.RivalUserId, r.Source, r.CreatedDate,
                   u.Username, u.DisplayName,
                   CASE WHEN r2.Id IS NOT NULL THEN 1 ELSE 0 END AS IsMutual
            FROM B3tz_Rivals r
            JOIN B3tz_Users u ON u.Id = r.RivalUserId
            LEFT JOIN B3tz_Rivals r2 ON r2.UserId = r.RivalUserId AND r2.RivalUserId = r.UserId
            WHERE r.UserId = @userId
            ORDER BY r.CreatedDate DESC
          `);
        const rivals = result.recordset.map(r => ({
          id: r.RivalUserId,
          username: r.Username,
          displayName: r.DisplayName || r.Username,
          source: r.Source,
          isMutual: !!r.IsMutual,
          createdDate: r.CreatedDate
        }));
        return sendJSON(res, 200, { rivals });
      } catch (e) {
        console.error('Rivals error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to load rivals' });
      }
    } else {
      return sendJSON(res, 200, { rivals: [] });
    }
  }

  // ══════════════════════════════════════
  // ── API: Mark/Unmark Rival ──
  // ══════════════════════════════════════

  if (pathname === '/api/rivals/toggle' && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;
    const body = await parseBody(req);
    const { rivalUserId } = body;

    if (!rivalUserId || rivalUserId === userId) {
      return sendJSON(res, 400, { error: 'Invalid rival' });
    }

    if (dbPool) {
      try {
        // Check if already a rival
        const existing = await dbPool.request()
          .input('userId', sql.Int, userId)
          .input('rivalId', sql.Int, rivalUserId)
          .query('SELECT Id FROM B3tz_Rivals WHERE UserId = @userId AND RivalUserId = @rivalId');

        if (existing.recordset.length > 0) {
          // Remove rival
          await dbPool.request()
            .input('userId', sql.Int, userId)
            .input('rivalId', sql.Int, rivalUserId)
            .query('DELETE FROM B3tz_Rivals WHERE UserId = @userId AND RivalUserId = @rivalId');
          return sendJSON(res, 200, { action: 'removed', rivalUserId });
        } else {
          // Add rival
          await dbPool.request()
            .input('userId', sql.Int, userId)
            .input('rivalId', sql.Int, rivalUserId)
            .query("INSERT INTO B3tz_Rivals (UserId, RivalUserId, Source) VALUES (@userId, @rivalId, 'manual')");

          // Check if mutual
          const mutual = await dbPool.request()
            .input('userId', sql.Int, userId)
            .input('rivalId', sql.Int, rivalUserId)
            .query('SELECT Id FROM B3tz_Rivals WHERE UserId = @rivalId AND RivalUserId = @userId');

          return sendJSON(res, 200, { action: 'added', rivalUserId, isMutual: mutual.recordset.length > 0 });
        }
      } catch (e) {
        console.error('Toggle rival error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to toggle rival' });
      }
    } else {
      return sendJSON(res, 200, { action: 'added', rivalUserId, isMutual: false });
    }
  }

  // ══════════════════════════════════════
  // ── API: Rival Bet IDs (for filter) ──
  // ══════════════════════════════════════

  if (pathname === '/api/rival-bet-ids' && req.method === 'GET') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;

    if (dbPool) {
      try {
        // Get bet IDs where any of the user's rivals have also placed bets
        const result = await dbPool.request()
          .input('userId', sql.Int, userId)
          .query(`
            SELECT DISTINCT ub.BetId, ub.UserId AS RivalUserId
            FROM B3tz_Rivals r
            JOIN B3tz_UserBets ub ON ub.UserId = r.RivalUserId
            WHERE r.UserId = @userId
          `);
        // Build a map: betId -> [rivalUserIds]
        const betRivals = {};
        for (const row of result.recordset) {
          if (!betRivals[row.BetId]) betRivals[row.BetId] = [];
          betRivals[row.BetId].push(row.RivalUserId);
        }
        return sendJSON(res, 200, { betRivals });
      } catch (e) {
        console.error('Rival bet IDs error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to load rival bet IDs' });
      }
    } else {
      return sendJSON(res, 200, { betRivals: {} });
    }
  }

  // ══════════════════════════════════════
  // ── API: Head-to-Head Stats ──
  // ══════════════════════════════════════

  const h2hMatch = pathname.match(/^\/api\/h2h\/(\d+)$/);
  if (h2hMatch && req.method === 'GET') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;
    const rivalId = parseInt(h2hMatch[1]);

    if (dbPool) {
      try {
        // Get rival info
        const rivalInfo = await dbPool.request()
          .input('rivalId', sql.Int, rivalId)
          .query('SELECT Username, DisplayName FROM B3tz_Users WHERE Id = @rivalId');
        if (rivalInfo.recordset.length === 0) return sendJSON(res, 404, { error: 'User not found' });
        const rival = rivalInfo.recordset[0];

        // Get all bets both users have bet on
        const shared = await dbPool.request()
          .input('u1', sql.Int, userId)
          .input('u2', sql.Int, rivalId)
          .query(`
            SELECT ub1.BetId, ub1.Side AS MySide, ub2.Side AS TheirSide,
                   b.Title, b.Icon, b.Status, b.Resolution, b.YesOdds, b.NoOdds
            FROM B3tz_UserBets ub1
            JOIN B3tz_UserBets ub2 ON ub1.BetId = ub2.BetId AND ub2.UserId = @u2
            JOIN B3tz_Bets b ON b.Id = ub1.BetId
            WHERE ub1.UserId = @u1
            ORDER BY b.CreatedDate DESC
          `);

        let myWins = 0, theirWins = 0, ties = 0, opposing = 0;
        const sharedBets = shared.recordset.map(r => {
          const sameSide = r.MySide === r.TheirSide;
          if (!sameSide) opposing++;
          if (r.Status === 'resolved' && r.Resolution) {
            const iWon = r.MySide === r.Resolution;
            const theyWon = r.TheirSide === r.Resolution;
            if (iWon && !theyWon) myWins++;
            else if (theyWon && !iWon) theirWins++;
            else ties++;
          }
          return {
            betId: r.BetId, title: r.Title, icon: r.Icon,
            mySide: r.MySide, theirSide: r.TheirSide,
            status: r.Status, resolution: r.Resolution,
            sameSide
          };
        });

        return sendJSON(res, 200, {
          rival: { id: rivalId, username: rival.Username, displayName: rival.DisplayName || rival.Username },
          stats: { sharedBets: sharedBets.length, opposing, myWins, theirWins, ties },
          bets: sharedBets
        });
      } catch (e) {
        console.error('H2H error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to load head-to-head' });
      }
    } else {
      return sendJSON(res, 200, { rival: {}, stats: { sharedBets: 0, opposing: 0, myWins: 0, theirWins: 0, ties: 0 }, bets: [] });
    }
  }

  // ══════════════════════════════════
  // ── API: Leaderboard ──
  // ══════════════════════════════════

  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    try {
      if (dbPool) {
        const result = await dbPool.request().query(`
          SELECT
            u.Id, u.Username, u.DisplayName,
            COUNT(DISTINCT ub.BetId) AS totalBets,
            SUM(CASE WHEN b.Status = 'resolved' AND (
              (ub.Side = 'yes' AND b.Resolution = 'yes') OR
              (ub.Side = 'no' AND b.Resolution = 'no')
            ) THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN b.Status = 'resolved' AND b.Resolution IS NOT NULL AND (
              (ub.Side = 'yes' AND b.Resolution = 'no') OR
              (ub.Side = 'no' AND b.Resolution = 'yes')
            ) THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN b.Status = 'resolved' AND b.Resolution IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
            (SELECT COUNT(*) FROM B3tz_Bets WHERE CreatedByUserId = u.Id) AS betsCreated,
            (SELECT COUNT(DISTINCT RivalUserId) FROM B3tz_Rivals WHERE UserId = u.Id) AS rivalCount,
            (SELECT COUNT(DISTINCT r2.RivalUserId) FROM B3tz_Rivals r1
              JOIN B3tz_Rivals r2 ON r1.RivalUserId = r2.UserId AND r2.RivalUserId = r1.UserId
              WHERE r1.UserId = u.Id) AS nemesisCount,
            (SELECT COUNT(*) FROM B3tz_Challenges WHERE SenderUserId = u.Id) AS challengesSent,
            COUNT(DISTINCT b.Category) AS categoriesPlayed
          FROM B3tz_Users u
          LEFT JOIN B3tz_UserBets ub ON ub.UserId = u.Id
          LEFT JOIN B3tz_Bets b ON b.Id = ub.BetId
          GROUP BY u.Id, u.Username, u.DisplayName
          HAVING COUNT(DISTINCT ub.BetId) >= 1
          ORDER BY COUNT(DISTINCT ub.BetId) DESC
        `);

        // Compute composite B3tz Score and streaks client-side is fine
        // but let's also get per-user category breakdown for top category
        const catResult = await dbPool.request().query(`
          SELECT ub.UserId, b.Category, COUNT(*) AS cnt
          FROM B3tz_UserBets ub
          JOIN B3tz_Bets b ON b.Id = ub.BetId
          GROUP BY ub.UserId, b.Category
        `);
        const userCats = {};
        for (const row of catResult.recordset) {
          if (!userCats[row.UserId]) userCats[row.UserId] = {};
          userCats[row.UserId][row.Category] = row.cnt;
        }

        const players = result.recordset.map(r => {
          const winRate = r.resolved > 0 ? (r.wins / r.resolved) : 0;
          // B3tz Score: weighted composite
          // 40% accuracy (if enough resolved), 30% volume, 20% social, 10% creation
          const accuracyScore = r.resolved >= 3 ? winRate * 100 : 50; // default 50 if not enough data
          const volumeScore = Math.min(r.totalBets * 5, 100); // cap at 20 bets = 100
          const socialScore = Math.min((r.rivalCount * 10) + (r.nemesisCount * 20), 100);
          const creationScore = Math.min(r.betsCreated * 10, 100);
          const b3tzScore = Math.round(
            (accuracyScore * 0.4) + (volumeScore * 0.3) + (socialScore * 0.2) + (creationScore * 0.1)
          );

          // Find signature stat (what they're best at)
          let signature = { type: 'volume', label: r.totalBets + ' bets', icon: '🎲' };
          if (r.resolved >= 3 && winRate >= 0.65) signature = { type: 'accuracy', label: Math.round(winRate * 100) + '% win rate', icon: '🎯' };
          else if (r.nemesisCount >= 2) signature = { type: 'nemesis', label: r.nemesisCount + ' nemeses', icon: '🔥' };
          else if (r.rivalCount >= 3) signature = { type: 'social', label: r.rivalCount + ' rivals', icon: '⚔️' };
          else if (r.betsCreated >= 3) signature = { type: 'creator', label: r.betsCreated + ' created', icon: '✨' };
          else if (r.challengesSent >= 2) signature = { type: 'challenger', label: r.challengesSent + ' challenges', icon: '📨' };

          // Top category
          const cats = userCats[r.Id] || {};
          const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];

          return {
            id: r.Id,
            username: r.Username,
            displayName: r.DisplayName || r.Username,
            totalBets: r.totalBets,
            wins: r.wins,
            losses: r.losses,
            resolved: r.resolved,
            winRate: r.resolved > 0 ? Math.round(winRate * 100) : null,
            betsCreated: r.betsCreated,
            rivalCount: r.rivalCount,
            nemesisCount: r.nemesisCount,
            challengesSent: r.challengesSent,
            categoriesPlayed: r.categoriesPlayed,
            topCategory: topCat ? topCat[0] : null,
            b3tzScore,
            signature
          };
        });

        // Sort by B3tz Score descending
        players.sort((a, b) => b.b3tzScore - a.b3tzScore);
        // Assign ranks
        players.forEach((p, i) => p.rank = i + 1);

        return sendJSON(res, 200, { players });
      } else {
        return sendJSON(res, 200, { players: [] });
      }
    } catch (e) {
      console.error('Leaderboard error:', e.message);
      return sendJSON(res, 500, { error: 'Failed to load leaderboard' });
    }
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
    if (!position || (position !== 'yes' && position !== 'no')) {
      return sendJSON(res, 400, { error: 'You must pick a side (Yes or No) before creating a bet' });
    }

    // Final content safety check on the title and resolution criteria
    const titleCheck = preFilterBetInput(title);
    if (titleCheck.blocked) {
      return sendJSON(res, 400, { error: titleCheck.reason });
    }
    if (resolution_criteria) {
      const criteriaCheck = preFilterBetInput(resolution_criteria);
      if (criteriaCheck.blocked) {
        return sendJSON(res, 400, { error: criteriaCheck.reason });
      }
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
      yes_odds: side === 'yes' ? 100 : 0,
      no_odds: side === 'yes' ? 0 : 100,
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
        const apiBet = { id: betId, ...newBet, created_date: new Date().toISOString() };
        bets.unshift(apiBet);
        return sendJSON(res, 201, { bet: apiBet });
      } catch (e) {
        console.error('Create bet DB error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to create bet' });
      }
    } else {
      const apiBet = { id: bets.length + 100, ...newBet, created_date: new Date().toISOString() };
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

      // If resolved, apply the resolution
      if (verdict.status === 'resolved') {
        bet.status = 'resolved';
        bet.resolution = verdict.resolution;
        bet.resolution_reason = verdict.reason;

        if (dbPool) {
          try {
            await dbPool.request()
              .input('id', sql.Int, bet.id)
              .input('status', sql.NVarChar, 'resolved')
              .input('resolution', sql.NVarChar, verdict.resolution)
              .input('reason', sql.NVarChar, verdict.reason)
              .query(`UPDATE B3tz_Bets SET Status = @status, Resolution = @resolution, ResolutionReason = @reason, ResolvedDate = GETUTCDATE() WHERE Id = @id`);
          } catch (e) {
            console.error('DB update error for arbitrated bet', bet.id, e.message);
          }
        }
      }

      return sendJSON(res, 200, { verdict, bet });
    } catch (e) {
      console.error('Single arbitration error:', e.message);
      return sendJSON(res, 500, { error: 'Arbitration failed' });
    }
  }

  // ══════════════════════════════════
  // ── API: Private Bets (Nemesis 1v1) ──
  // ══════════════════════════════════

  if (pathname === '/api/private-bets/create' && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;
    const body = await parseBody(req);
    const { challengedId, title, icon, category, eventDate, resolutionCriteria, challengerSide } = body;

    if (!challengedId || !title || !challengerSide) {
      return sendJSON(res, 400, { error: 'Missing required fields: challengedId, title, challengerSide' });
    }
    if (!['yes', 'no'].includes(challengerSide)) {
      return sendJSON(res, 400, { error: 'challengerSide must be yes or no' });
    }
    if (parseInt(challengedId) === userId) {
      return sendJSON(res, 400, { error: 'Cannot challenge yourself' });
    }

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('challengerId', sql.Int, userId)
          .input('challengedId', sql.Int, parseInt(challengedId))
          .input('title', sql.NVarChar, title.substring(0, 300))
          .input('icon', sql.NVarChar, (icon || '🔥').substring(0, 10))
          .input('category', sql.NVarChar, (category || 'General').substring(0, 50))
          .input('eventDate', sql.NVarChar, (eventDate || '').substring(0, 50))
          .input('resolutionCriteria', sql.NVarChar, (resolutionCriteria || '').substring(0, 2000))
          .input('challengerSide', sql.NVarChar, challengerSide)
          .query(`
            INSERT INTO B3tz_PrivateBets (ChallengerId, ChallengedId, Title, Icon, Category, EventDate, ResolutionCriteria, ChallengerSide)
            OUTPUT INSERTED.*
            VALUES (@challengerId, @challengedId, @title, @icon, @category, @eventDate, @resolutionCriteria, @challengerSide)
          `);
        const created = result.recordset[0];
        return sendJSON(res, 201, { privateBet: created });
      } catch (e) {
        console.error('Create private bet error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to create private bet' });
      }
    } else {
      return sendJSON(res, 500, { error: 'Database required for private bets' });
    }
  }

  if (pathname.match(/^\/api\/private-bets\/\d+\/respond$/) && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;
    const betId = parseInt(pathname.split('/')[3]);
    const body = await parseBody(req);
    const { action } = body; // 'accept' or 'decline'

    if (!['accept', 'decline'].includes(action)) {
      return sendJSON(res, 400, { error: 'action must be accept or decline' });
    }

    if (dbPool) {
      try {
        // Verify this user is the challenged party and bet is pending
        const check = await dbPool.request()
          .input('id', sql.Int, betId)
          .input('userId', sql.Int, userId)
          .query('SELECT * FROM B3tz_PrivateBets WHERE Id = @id AND ChallengedId = @userId AND Status = \'pending\'');

        if (check.recordset.length === 0) {
          return sendJSON(res, 404, { error: 'No pending challenge found for you' });
        }

        const pb = check.recordset[0];
        const challengedSide = pb.ChallengerSide === 'yes' ? 'no' : 'yes';

        if (action === 'accept') {
          await dbPool.request()
            .input('id', sql.Int, betId)
            .input('challengedSide', sql.NVarChar, challengedSide)
            .query('UPDATE B3tz_PrivateBets SET Status = \'active\', ChallengedSide = @challengedSide, AcceptedDate = GETUTCDATE() WHERE Id = @id');
        } else {
          await dbPool.request()
            .input('id', sql.Int, betId)
            .query('UPDATE B3tz_PrivateBets SET Status = \'declined\' WHERE Id = @id');
        }

        return sendJSON(res, 200, { success: true, action, betId });
      } catch (e) {
        console.error('Respond to private bet error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to respond to private bet' });
      }
    } else {
      return sendJSON(res, 500, { error: 'Database required' });
    }
  }

  const privateBetsListMatch = pathname.match(/^\/api\/private-bets\/rival\/(\d+)$/);
  if (privateBetsListMatch && req.method === 'GET') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;
    const rivalId = parseInt(privateBetsListMatch[1]);

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('u1', sql.Int, userId)
          .input('u2', sql.Int, rivalId)
          .query(`
            SELECT pb.*,
                   uc.Username AS ChallengerUsername, uc.DisplayName AS ChallengerDisplayName,
                   ud.Username AS ChallengedUsername, ud.DisplayName AS ChallengedDisplayName,
                   uw.Username AS WinnerUsername, uw.DisplayName AS WinnerDisplayName
            FROM B3tz_PrivateBets pb
            LEFT JOIN B3tz_Users uc ON uc.Id = pb.ChallengerId
            LEFT JOIN B3tz_Users ud ON ud.Id = pb.ChallengedId
            LEFT JOIN B3tz_Users uw ON uw.Id = pb.WinnerId
            WHERE (pb.ChallengerId = @u1 AND pb.ChallengedId = @u2)
               OR (pb.ChallengerId = @u2 AND pb.ChallengedId = @u1)
            ORDER BY pb.CreatedDate DESC
          `);

        const privateBets = result.recordset.map(pb => ({
          id: pb.Id,
          challengerId: pb.ChallengerId,
          challengedId: pb.ChallengedId,
          challengerName: pb.ChallengerDisplayName || pb.ChallengerUsername,
          challengedName: pb.ChallengedDisplayName || pb.ChallengedUsername,
          title: pb.Title,
          icon: pb.Icon,
          category: pb.Category,
          eventDate: pb.EventDate,
          resolutionCriteria: pb.ResolutionCriteria,
          challengerSide: pb.ChallengerSide,
          challengedSide: pb.ChallengedSide,
          status: pb.Status,
          resolution: pb.Resolution,
          winnerId: pb.WinnerId,
          winnerName: pb.WinnerDisplayName || pb.WinnerUsername || null,
          createdDate: pb.CreatedDate,
          acceptedDate: pb.AcceptedDate,
          resolvedDate: pb.ResolvedDate
        }));

        return sendJSON(res, 200, { privateBets });
      } catch (e) {
        console.error('List private bets error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to list private bets' });
      }
    } else {
      return sendJSON(res, 200, { privateBets: [] });
    }
  }

  if (pathname === '/api/private-bets/pending' && req.method === 'GET') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('userId', sql.Int, userId)
          .query(`
            SELECT pb.*, uc.Username AS ChallengerUsername, uc.DisplayName AS ChallengerDisplayName
            FROM B3tz_PrivateBets pb
            JOIN B3tz_Users uc ON uc.Id = pb.ChallengerId
            WHERE pb.ChallengedId = @userId AND pb.Status = 'pending'
            ORDER BY pb.CreatedDate DESC
          `);

        const pending = result.recordset.map(pb => ({
          id: pb.Id,
          challengerId: pb.ChallengerId,
          challengerName: pb.ChallengerDisplayName || pb.ChallengerUsername,
          title: pb.Title,
          icon: pb.Icon,
          challengerSide: pb.ChallengerSide,
          createdDate: pb.CreatedDate
        }));

        return sendJSON(res, 200, { pending });
      } catch (e) {
        console.error('Pending private bets error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to load pending bets' });
      }
    } else {
      return sendJSON(res, 200, { pending: [] });
    }
  }

  if (pathname.match(/^\/api\/private-bets\/\d+\/resolve$/) && req.method === 'POST') {
    const user = dbPool ? await getUserFromSession(req) : memGetUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Must be logged in' });
    const userId = user.Id || user.id;
    const betId = parseInt(pathname.split('/')[3]);
    const body = await parseBody(req);
    const { resolution } = body; // 'yes' or 'no'

    if (!['yes', 'no'].includes(resolution)) {
      return sendJSON(res, 400, { error: 'resolution must be yes or no' });
    }

    if (dbPool) {
      try {
        // Get the private bet — must be active and involve this user
        const check = await dbPool.request()
          .input('id', sql.Int, betId)
          .input('userId', sql.Int, userId)
          .query('SELECT * FROM B3tz_PrivateBets WHERE Id = @id AND Status = \'active\' AND (ChallengerId = @userId OR ChallengedId = @userId)');

        if (check.recordset.length === 0) {
          return sendJSON(res, 404, { error: 'No active private bet found' });
        }

        const pb = check.recordset[0];
        // Determine winner
        let winnerId = null;
        if (pb.ChallengerSide === resolution) winnerId = pb.ChallengerId;
        else if (pb.ChallengedSide === resolution) winnerId = pb.ChallengedId;

        await dbPool.request()
          .input('id', sql.Int, betId)
          .input('resolution', sql.NVarChar, resolution)
          .input('winnerId', sql.Int, winnerId)
          .query('UPDATE B3tz_PrivateBets SET Status = \'resolved\', Resolution = @resolution, WinnerId = @winnerId, ResolvedDate = GETUTCDATE() WHERE Id = @id');

        return sendJSON(res, 200, { success: true, resolution, winnerId });
      } catch (e) {
        console.error('Resolve private bet error:', e.message);
        return sendJSON(res, 500, { error: 'Failed to resolve private bet' });
      }
    } else {
      return sendJSON(res, 500, { error: 'Database required' });
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
