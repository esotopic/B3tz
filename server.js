const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// In-memory bet store (will be replaced with DB later)
const bets = [
  {
    id: 1,
    title: "Russell will win Miami Grand Prix",
    category: "F1",
    event_date: "2026-05-03",
    created_by: "Angel",
    yes_odds: 34,
    no_odds: 66,
    yes_count: 127,
    no_count: 245,
    volume: 18600,
    status: "open",
    icon: "🏎️",
    featured: true
  },
  {
    id: 2,
    title: "Spain wins 2026 FIFA World Cup",
    category: "Soccer",
    event_date: "2026-07-19",
    created_by: "Carlos",
    yes_odds: 22,
    no_odds: 78,
    yes_count: 891,
    no_count: 3120,
    volume: 245000,
    status: "open",
    icon: "⚽",
    featured: true
  },
  {
    id: 3,
    title: "Bitcoin hits $200K before 2027",
    category: "Crypto",
    event_date: "2026-12-31",
    created_by: "Satoshi42",
    yes_odds: 41,
    no_odds: 59,
    yes_count: 2034,
    no_count: 2910,
    volume: 890000,
    status: "open",
    icon: "₿",
    featured: true
  },
  {
    id: 4,
    title: "AI passes bar exam with 99th percentile",
    category: "Tech",
    event_date: "2026-12-31",
    created_by: "TechWatcher",
    yes_odds: 73,
    no_odds: 27,
    yes_count: 456,
    no_count: 170,
    volume: 62000,
    status: "open",
    icon: "🤖"
  },
  {
    id: 5,
    title: "Lakers make NBA Finals 2026",
    category: "Basketball",
    event_date: "2026-06-15",
    created_by: "LakeShow",
    yes_odds: 18,
    no_odds: 82,
    yes_count: 312,
    no_count: 1420,
    volume: 95000,
    status: "open",
    icon: "🏀"
  },
  {
    id: 6,
    title: "Tesla releases sub-$25K vehicle in 2026",
    category: "Tech",
    event_date: "2026-12-31",
    created_by: "EVFanatic",
    yes_odds: 29,
    no_odds: 71,
    yes_count: 567,
    no_count: 1380,
    volume: 134000,
    status: "open",
    icon: "🚗"
  },
  {
    id: 7,
    title: "Ohtani hits 50+ HRs again in 2026",
    category: "Baseball",
    event_date: "2026-10-01",
    created_by: "DiamondDog",
    yes_odds: 38,
    no_odds: 62,
    yes_count: 890,
    no_count: 1450,
    volume: 78000,
    status: "open",
    icon: "⚾"
  },
  {
    id: 8,
    title: "Ethereum flips Bitcoin market cap",
    category: "Crypto",
    event_date: "2026-12-31",
    created_by: "DeFiMax",
    yes_odds: 8,
    no_odds: 92,
    yes_count: 234,
    no_count: 2700,
    volume: 156000,
    status: "open",
    icon: "⟠"
  },
  {
    id: 9,
    title: "US lands astronauts on Moon in 2026",
    category: "Science",
    event_date: "2026-12-31",
    created_by: "SpaceNerd",
    yes_odds: 15,
    no_odds: 85,
    yes_count: 345,
    no_count: 1960,
    volume: 210000,
    status: "open",
    icon: "🌙"
  },
  {
    id: 10,
    title: "Next GTA breaks day-one sales record",
    category: "Gaming",
    event_date: "2026-12-31",
    created_by: "PixelKing",
    yes_odds: 88,
    no_odds: 12,
    yes_count: 3400,
    no_count: 460,
    volume: 312000,
    status: "open",
    icon: "🎮"
  },
  {
    id: 11,
    title: "Verstappen wins F1 Championship 2026",
    category: "F1",
    event_date: "2026-12-15",
    created_by: "PitLane",
    yes_odds: 45,
    no_odds: 55,
    yes_count: 1230,
    no_count: 1500,
    volume: 178000,
    status: "open",
    icon: "🏎️"
  },
  {
    id: 12,
    title: "Drake drops album before summer 2026",
    category: "Music",
    event_date: "2026-06-21",
    created_by: "6ixGod",
    yes_odds: 52,
    no_odds: 48,
    yes_count: 678,
    no_count: 625,
    volume: 43000,
    status: "open",
    icon: "🎵"
  }
];

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  // API routes
  if (req.url === '/api/bets' && req.method === 'GET') {
    return sendJSON(res, 200, { bets });
  }

  if (req.url === '/api/categories' && req.method === 'GET') {
    const categories = [...new Set(bets.map(b => b.category))];
    return sendJSON(res, 200, { categories });
  }

  // Static file serving
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fallback to index.html for SPA routing
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`B3tz running on port ${PORT}`);
});
