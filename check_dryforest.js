const sql = require('mssql');

const config = {
  server: '***REMOVED***',
  database: '1000Problems',
  user: '***REMOVED***',
  password: '***REMOVED***',
  options: { encrypt: true, trustServerCertificate: false }
};

async function main() {
  const pool = await sql.connect(config);
  
  // Find dryforest user
  const userResult = await pool.request()
    .query("SELECT Id, Username, DisplayName FROM B3tz_Users WHERE Username = 'dryforest'");
  console.log('=== DRYFOREST USER ===');
  console.log(JSON.stringify(userResult.recordset, null, 2));
  
  if (userResult.recordset.length === 0) {
    console.log('User not found!');
    await pool.close();
    return;
  }
  
  const userId = userResult.recordset[0].Id;
  
  // Get ALL bets by dryforest
  const betsResult = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT ub.Id, ub.BetId, ub.Side, ub.PlacedDate, b.Title, b.Category 
            FROM B3tz_UserBets ub 
            JOIN B3tz_Bets b ON b.Id = ub.BetId 
            WHERE ub.UserId = @userId
            ORDER BY ub.PlacedDate DESC`);
  console.log('\n=== ALL DRYFOREST BETS ===');
  console.log(JSON.stringify(betsResult.recordset, null, 2));
  console.log('Total bets:', betsResult.recordset.length);
  
  // Check challenges involving dryforest
  const challengeResult = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT c.*, b.Title as BetTitle 
            FROM B3tz_Challenges c 
            JOIN B3tz_Bets b ON b.Id = c.BetId
            WHERE c.SenderUserId = @userId OR c.RecipientUserId = @userId
            ORDER BY c.CreatedDate DESC`);
  console.log('\n=== CHALLENGES INVOLVING DRYFOREST ===');
  console.log(JSON.stringify(challengeResult.recordset, null, 2));
  
  await pool.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
